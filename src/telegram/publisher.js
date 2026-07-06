import { Telegraf } from 'telegraf';
import { formatSelectionHeader } from '../core/format.js';
import { formatJobs } from '../core/jobs.js';
import { formatPublicationPosts, formatPublications } from '../core/publications.js';
import { getLogger } from '../core/logger.js';
import { buildSelectionSpecs, loadSelection } from '../core/selection.js';
import { buildStats, formatStats } from '../core/stats.js';
import { JobGate } from '../runtime/jobGate.js';
import { getLocalTimestampBucket } from '../runtime/scheduler.js';
import { withBotApiRetry } from './retry.js';
import { sendRichPost } from './richPost.js';

export class SelectionPublisher {
  constructor({ repository, mediaDownloader, setupAssistant, syncWorker = null, jobGate = new JobGate(), config }) {
    this.repository = repository;
    this.mediaDownloader = mediaDownloader;
    this.setupAssistant = setupAssistant;
    this.syncWorker = syncWorker;
    this.jobGate = jobGate;
    this.config = config;
    this.bot = new Telegraf(config.telegram.botToken);
    this.logger = getLogger('publisher');
    this.activeHandlers = 0;
    this.idleResolvers = [];
    this.processingPublications = false;
    this.configureCommands();
  }

  configureCommands() {
    this.bot.catch((error, ctx) => this.handleBotError(error, ctx));

    this.bot.use(async (ctx, next) => {
      this.activeHandlers += 1;
      try {
        await next();
      } finally {
        this.activeHandlers -= 1;
        this.resolveIdle();
      }
    });

    this.bot.use(async (ctx, next) => {
      const command = getCommandName(ctx);
      if (ctx.from?.id !== Number(this.config.telegram.adminId) || ctx.chat?.type !== 'private') {
        if (command) {
          this.logger.warn('Bot command ignored', {
            command,
            fromId: ctx.from?.id,
            chatId: ctx.chat?.id,
            chatType: ctx.chat?.type
          });
        }
        return;
      }
      if (command) {
        this.logger.debug('Bot command received', {
          command,
          fromId: ctx.from?.id,
          chatId: ctx.chat?.id
        });
      }
      await next();
    });

    this.bot.start((ctx) => ctx.reply('Available commands: /stats, /jobs, /publications, /publication, /sync, /backfill, /publish, /setup'));
    this.bot.command('stats', async (ctx) => {
      const stats = await buildStats(this.repository, this.config);
      await ctx.reply(formatStats(stats, this.config.templates));
    });
    this.bot.command('jobs', async (ctx) => this.replyJobs(ctx));
    this.bot.command('publications', async (ctx) => this.replyPublications(ctx));
    this.bot.command('publication', async (ctx) => this.replyPublication(ctx));
    this.bot.command('sync', async (ctx) => this.runManualSync(ctx));
    this.bot.command('backfill', async (ctx) => this.runManualBackfill(ctx));
    this.bot.command('publish', async (ctx) => this.runManualPublish(ctx));
    this.setupAssistant?.register(this.bot);
  }

  async handleBotError(error, ctx) {
    const command = getCommandName(ctx);
    this.logger.error('Bot command failed', {
      command: command || '',
      fromId: ctx?.from?.id,
      chatId: ctx?.chat?.id,
      error: error?.message || String(error)
    });

    if (ctx?.from?.id !== Number(this.config.telegram.adminId) || ctx?.chat?.type !== 'private') return;

    try {
      await ctx.reply(formatBotError(error));
    } catch (replyError) {
      this.logger.error('Failed to send bot command error reply', {
        command: command || '',
        error: replyError?.message || String(replyError)
      });
    }
  }

  async publishAll(now = new Date(), keys = null, options = {}) {
    return this.planPublicationRequests(now, keys, options);
  }

  schedulePublicationRequestFromSchedule(key, scheduledAt = new Date()) {
    const specs = buildSelectionSpecs(this.config, scheduledAt, key);
    if (specs.length === 0) {
      this.logger.warn('Scheduled publication skipped', {
        selectionKey: key,
        scheduledAt,
        reason: 'empty_selection'
      });
      return {
        status: 'skipped',
        key: `publish-schedule:${key}`,
        reason: 'empty_selection',
        promise: Promise.resolve({
          skipped: true,
          reason: 'empty_selection',
          selections: []
        })
      };
    }

    const gateKey = `publish-schedule:${getPublicationKeyFromSpec(specs[0], this.config)}`;
    const job = this.jobGate.run(gateKey, () => this.planPublicationRequests(scheduledAt, key, { source: 'schedule' }));
    if (job.status === 'skipped' || job.status === 'busy') {
      this.logger.warn('Scheduled publication enqueue skipped', {
        selectionKey: key,
        publicationKey: gateKey.slice('publish-schedule:'.length),
        scheduledAt,
        status: job.status,
        reason: job.reason || ''
      });
    } else {
      this.logger.debug('Scheduled publication enqueue job accepted', {
        selectionKey: key,
        publicationKey: gateKey.slice('publish-schedule:'.length),
        scheduledAt,
        status: job.status
      });
    }
    return job;
  }

  async planPublicationRequests(now = new Date(), keys = null, options = {}) {
    const specs = buildSelectionSpecs(this.config, now, keys, {
      includeDisabled: Boolean(options.force && keys),
      ignoreFirstSendAt: Boolean(options.force)
    });
    this.logger.debug('Publish planning started', {
      targetChatId: this.config.telegram.publishChannelId,
      keys: keys || 'all',
      selections: specs.length,
      force: Boolean(options.force)
    });
    const results = [];
    for (const spec of specs) {
      results.push(await this.planPublicationRequest(spec, options));
    }
    return {
      selections: specs.map((spec, index) => ({
        key: spec.key,
        ...results[index]
      }))
    };
  }

  async planPublicationRequest(spec, options = {}) {
    if (!options.force && isBeforeFirstSendAt(spec.scheduledAtIso || spec.untilIso, spec.firstSendAtIso)) {
      this.logger.info('Publication request skipped before first send time', {
        selection: spec.key,
        scheduledAt: spec.scheduledAtIso || spec.untilIso,
        firstSendAt: spec.firstSendAtIso
      });
      return {
        status: 'first_send_pending',
        requested: false,
        firstSendAt: spec.firstSendAtIso
      };
    }

    const canonicalKey = getPublicationKeyFromSpec(spec, this.config);
    if (!options.force) {
      const existing = await getBlockingPublication(this.repository, canonicalKey);
      if (isBlockingPublication(existing)) {
        this.logger.info('Publication request skipped: already published or scheduled', {
          selection: spec.key,
          publicationKey: canonicalKey,
          status: existing.status
        });
        return {
          status: 'exists',
          requested: false,
          publicationId: existing.id,
          publicationStatus: existing.status,
          publicationKey: canonicalKey
        };
      }
    }

    const selection = await loadSelection(this.repository, spec);
    return this.createPublicationRequest(selection, { ...options, canonicalKey });
  }

  async createPublicationRequest(selection, options = {}) {
    if (selection.posts.length === 0) {
      this.logger.warn('Publication request skipped: no posts found for period', {
        selection: selection.key,
        periodStart: selection.sinceIso,
        periodEnd: selection.untilIso,
        reason: 'empty_period'
      });
      return { status: 'empty', requested: false, count: 0 };
    }

    const canonicalKey = options.canonicalKey || getPublicationKey(selection, this.config);
    const key = options.force ? getForcedPublicationKey(selection, this.config) : canonicalKey;
    const publicationId = await this.repository.tryCreatePublicationRequest({
      key,
      selectionKey: selection.key,
      title: selection.title,
      periodStart: selection.sinceIso,
      periodEnd: selection.untilIso,
      data: { count: selection.posts.length, key, canonicalKey, forced: Boolean(options.force), selection }
    });
    if (!publicationId) {
      const existing = await getBlockingPublication(this.repository, canonicalKey);
      this.logger.warn('Publication request skipped: another scheduler already created it', {
        selection: selection.key,
        publicationKey: canonicalKey,
        status: existing?.status
      });
      return {
        status: existing?.status ? 'exists' : 'duplicate',
        requested: false,
        count: selection.posts.length,
        publicationId: existing?.id || null,
        publicationStatus: existing?.status || '',
        publicationKey: canonicalKey
      };
    }
    this.logger.info('Publication request created', { publicationId, selection: selection.key, key, posts: selection.posts.length });
    return {
      status: 'scheduled',
      requested: true,
      count: selection.posts.length,
      publicationId,
      publicationKey: key,
      forced: Boolean(options.force)
    };
  }

  async processPublicationQueue() {
    if (this.processingPublications) {
      this.logger.debug('Publication worker skipped: already running');
      return;
    }
    this.processingPublications = true;
    try {
      while (true) {
        const request = await this.repository.getNextPublicationRequest({
          requestTtlHours: getPublicationRequestTtlHours(this.config)
        });
        if (!request) break;
        await this.processPublicationRequest(request);
      }
    } finally {
      this.processingPublications = false;
    }
  }

  runPublicationWorker(source = 'manual') {
    return this.jobGate.run('publish-worker', () => this.executePublicationWorker(source), { queueIfRunning: true });
  }

  async executePublicationWorker(source) {
    this.logger.debug('Publication worker job started', { source });
    try {
      await this.processPublicationQueue();
      this.logger.debug('Publication worker job finished', { source });
      return { source };
    } catch (error) {
      this.logger.error('Publication worker job failed', {
        source,
        error: error?.message || String(error)
      });
      return {
        failed: true,
        source,
        error: error?.message || String(error)
      };
    }
  }

  async processPublicationRequest(request) {
    const selection = request.data?.selection;
    if (!selection?.posts?.length) {
      await this.repository.failPublication(request.id, new Error('Publication request has no selection snapshot'));
      return;
    }

    if (this.config.publish.dryRun) {
      this.logger.info('Selection dry-run', {
        selection: selection.key,
        title: selection.title,
        posts: selection.posts.length,
        targetChatId: this.config.telegram.publishChannelId
      });
      await this.recordPublication(request.id, selection, 'dry_run', { key: request.key });
      return;
    }

    try {
      if (request.status === 'created') {
        this.logger.info('Publishing selection header', {
          publicationId: request.id,
          selection: selection.key,
          title: selection.title,
          posts: selection.posts.length,
          targetChatId: this.config.telegram.publishChannelId,
          key: request.key
        });
        await withBotApiRetry(
          () => this.bot.telegram.sendMessage(this.config.telegram.publishChannelId, formatSelectionHeader(selection.title)),
          { label: 'sendSelectionHeader' }
        );
        await this.repository.markPublicationRunning(request.id);
      }

      const sentRows = await this.repository.listPublicationPosts(request.id);
      const sentPositions = new Set(sentRows.map((row) => row.position));

      for (let index = 0; index < selection.posts.length; index += 1) {
        const position = index + 1;
        if (sentPositions.has(position)) {
          this.logger.debug('Publication post skipped: already sent', {
            publicationId: request.id,
            selection: selection.key,
            position
          });
          continue;
        }
        const result = await this.publishPost(selection.posts[index], index);
        await this.repository.recordPublicationPost({
          publicationId: request.id,
          post: selection.posts[index],
          position,
          botMessageId: getBotMessageId(result)
        });
      }
      await this.recordPublication(request.id, selection, 'published', { key: request.key });
    } catch (error) {
      await this.repository.updatePublicationError(request.id, error);
      throw error;
    }
  }

  async publishPost(post, index) {
    this.logger.info('Publishing post', {
      targetChatId: this.config.telegram.publishChannelId,
      sourceChatId: post.chatId,
      messageId: post.messageId,
      position: index + 1
    });
    return sendRichPost({
      telegram: this.bot.telegram,
      chatId: this.config.telegram.publishChannelId,
      mediaDownloader: this.mediaDownloader,
      post,
      index,
      templates: this.config.templates
    });
  }

  async recordPublication(publicationId, selection, status, data = {}) {
    await this.repository.finishPublication(publicationId, {
      status,
      posts: selection.posts,
      data: { count: selection.posts.length, ...data }
    });
  }

  async replyJobs(ctx) {
    const jobs = await this.repository.listPublicationJobs({ finishedLimit: 5 });
    await ctx.reply(formatJobs(jobs), { parse_mode: 'HTML' });
  }

  async replyPublications(ctx) {
    const publications = await this.repository.listRecentPublications({ limit: 10 });
    await ctx.reply(formatPublications(publications), { parse_mode: 'HTML' });
  }

  async replyPublication(ctx) {
    const publicationId = parseRequiredPositiveInteger(getCommandArgument(ctx), 'publication id');
    const publication = await this.repository.getPublicationById(publicationId);
    if (!publication) {
      await ctx.reply(`Publication not found: ${publicationId}`);
      return;
    }
    const posts = await this.repository.listPublicationPostsDetailed(publicationId);
    await ctx.reply(formatPublicationPosts(publication, posts), { parse_mode: 'HTML' });
  }

  async runManualSync(ctx) {
    if (!this.syncWorker) {
      await ctx.reply('Sync worker is not available.');
      return;
    }
    const job = await this.syncWorker.sync('admin');
    await ctx.reply(formatJobStatus('Sync', job));
    await this.replyManualJobResult(ctx, 'Sync', job);
  }

  async runManualBackfill(ctx) {
    if (!this.syncWorker) {
      await ctx.reply('Sync worker is not available.');
      return;
    }
    const days = parseOptionalPositiveInteger(getCommandArgument(ctx));
    const job = await this.syncWorker.backfill(days, 'admin');
    await ctx.reply(formatJobStatus('Backfill', job));
    await this.replyManualJobResult(ctx, 'Backfill', job);
  }

  async replyManualJobResult(ctx, label, job) {
    if (!shouldWaitForManualJob(job)) return;
    const result = await waitForManualJob(job);
    await ctx.reply(formatManualJobResult(label, result));
  }

  async runManualPublish(ctx) {
    const args = getCommandArguments(ctx);
    const force = args.some(isForceFlag);
    const keys = args.filter((arg) => !isForceFlag(arg));
    if (keys.length === 0) {
      await ctx.reply(formatPublishHelp());
      return;
    }
    const result = await this.publishAll(new Date(), keys, { force });
    const job = result.selections.some((selection) => selection.requested)
      ? this.runPublicationWorker('admin')
      : null;
    await ctx.reply(formatPublishResult(result, job));
  }

  launchBot() {
    this.logger.debug('Launching bot polling', {
      adminId: this.config.telegram.adminId,
      publishChannelId: this.config.telegram.publishChannelId
    });
    void this.bot.launch()
      .then(() => {
        this.logger.debug('Bot polling finished');
      })
      .catch((error) => {
        this.logger.error('Bot polling failed', { error: error?.message || String(error) });
      });
    this.logger.debug('Bot polling launch requested');
  }

  async stopBot(signal = 'SIGTERM') {
    this.logger.debug('Stopping bot polling', { signal });
    try {
      this.bot.stop(signal);
    } catch (error) {
      if (!isBotAlreadyStoppedError(error)) throw error;
    }
    await this.waitForIdle();
    this.logger.debug('Bot polling stopped');
  }

  async waitForIdle(timeoutMs = 30000) {
    if (this.activeHandlers === 0) return;

    const idle = new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([idle, timeout]);
    if (result === 'timeout') {
      this.logger.warn('Timed out waiting for active bot handlers', { activeHandlers: this.activeHandlers, timeoutMs });
    }
  }

  resolveIdle() {
    if (this.activeHandlers !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}

function isBotAlreadyStoppedError(error) {
  return /not running|not started/i.test(String(error?.message || error));
}

function getCommandName(ctx) {
  const text = ctx.message?.text || ctx.update?.message?.text || '';
  const match = text.match(/^\/([^\s@]+)(?:@\w+)?/);
  return match?.[1] || '';
}

function getPublicationKey(selection, config) {
  return [
    'publish',
    selection.source,
    selection.templateKey || String(selection.key).split('.')[1],
    getLocalTimestampBucket(new Date(selection.scheduledAtIso || selection.untilIso), config.schedule?.timezone || 'UTC')
  ].join(':');
}

function getPublicationKeyFromSpec(spec, config) {
  return getPublicationKey(spec, config);
}

function isBlockingPublication(publication) {
  return ['created', 'running', 'published'].includes(publication?.status);
}

function isBeforeFirstSendAt(scheduledAtIso, firstSendAtIso) {
  if (!firstSendAtIso) return false;
  const scheduledAt = new Date(scheduledAtIso);
  const firstSendAt = new Date(firstSendAtIso);
  if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(firstSendAt.getTime())) return false;
  return scheduledAt < firstSendAt;
}

async function getBlockingPublication(repository, key) {
  if (typeof repository.getBlockingPublicationByKey === 'function') {
    return repository.getBlockingPublicationByKey(key);
  }
  return repository.getPublicationByKey(key);
}

function getForcedPublicationKey(selection, config) {
  return [
    'publish',
    'force',
    randomCode(),
    selection.source,
    selection.templateKey || String(selection.key).split('.')[1],
    getLocalTimestampBucket(new Date(selection.scheduledAtIso || selection.untilIso), config.schedule?.timezone || 'UTC')
  ].join(':');
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8);
}

function getPublicationRequestTtlHours(config) {
  return Math.max(1, Number(config.publish?.requestTtlHours ?? 12));
}

function getBotMessageId(result) {
  if (Array.isArray(result)) return result[0]?.message_id || result[0]?.messageId || null;
  return result?.message_id || result?.messageId || null;
}

function getCommandArgument(ctx) {
  const text = ctx.message?.text || ctx.update?.message?.text || '';
  return text.trim().split(/\s+/)[1];
}

function getCommandArguments(ctx) {
  const text = ctx.message?.text || ctx.update?.message?.text || '';
  return text.trim().split(/\s+/).slice(1).filter(Boolean);
}

function isForceFlag(value) {
  return value === '--force' || value === '-force';
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return number;
}

function parseRequiredPositiveInteger(value, label) {
  const number = parseOptionalPositiveInteger(value);
  if (number === undefined) throw new Error(`Usage: /publication <${label}>`);
  return number;
}

function formatJobStatus(label, job) {
  if (job.status === 'skipped' || job.status === 'busy') {
    return `${label} job status: ${job.status} (${job.reason})`;
  }
  return `${label} job status: ${job.status}`;
}

function shouldWaitForManualJob(job) {
  return Boolean(job?.promise) && (job.status === 'running' || job.status === 'scheduled');
}

async function waitForManualJob(job) {
  try {
    return await job.promise;
  } catch (error) {
    return {
      failed: true,
      error: error?.message || String(error)
    };
  }
}

function formatManualJobResult(label, result) {
  if (result?.failed) return `${label} failed: ${result.error || 'unknown error'}`;
  if (result?.skipped) return `${label} skipped: ${result.reason || 'skipped'}`;
  if (label === 'Sync') return formatSyncResult(result || {});
  if (label === 'Backfill') return formatBackfillResult(result || {});
  return `${label} finished.`;
}

function formatSyncResult(result) {
  return compactLines([
    'Sync finished',
    result.isInitial === true ? 'mode: initial' : result.isInitial === false ? 'mode: refresh' : null,
    formatStatLine('since', result.since),
    formatStatLine('pages', result.pages),
    formatStatLine('fetched', result.fetched),
    formatStatLine('matched', result.matched),
    formatStatLine('saved', result.saved),
    formatStatLine('skipped old', result.skippedOld),
    formatStatLine('deleted', result.deleted),
    formatStatLine('seen', result.seen),
    formatStatLine('stop reason', result.stopReason)
  ]);
}

function formatBackfillResult(result) {
  const matchedButNotStored = sumNumbers(result.skippedOld, result.skippedExistingOld);
  return compactLines([
    'Backfill finished',
    formatStatLine('days', result.days),
    formatStatLine('since', result.since),
    formatStatLine('update since', result.updateSince),
    formatStatLine('pages', result.pages),
    formatStatLine('fetched', result.fetched),
    formatStatLine('matched', result.matched),
    formatStatLine('added', result.added),
    formatStatLine('updated', result.updated),
    formatStatLine('skipped existing old', result.skippedExistingOld),
    formatStatLine('skipped old', result.skippedOld),
    Number.isFinite(matchedButNotStored) && matchedButNotStored > 0
      ? formatStatLine('matched but not stored', matchedButNotStored)
      : null,
    formatStatLine('deleted', result.deleted),
    formatStatLine('seen', result.seen),
    formatStatLine('stop reason', result.stopReason)
  ]);
}

function compactLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function formatStatLine(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return `${label}: ${value}`;
}

function sumNumbers(...values) {
  let sum = 0;
  let hasNumber = false;
  for (const value of values) {
    if (!Number.isFinite(Number(value))) continue;
    sum += Number(value);
    hasNumber = true;
  }
  return hasNumber ? sum : Number.NaN;
}

function formatPublishResult(result, job = null) {
  if (result.selections.length === 0) {
    return 'No enabled selections matched. Use -force to publish an explicitly disabled selection.';
  }
  const requested = result.selections.some((selection) => selection.requested || selection.status === 'scheduled');
  const lines = result.selections.map((selection) => {
    if (selection.status === 'scheduled') {
      return `${selection.key}: publication request created (${selection.count} posts)${selection.forced ? ' forced' : ''}`;
    }
    if (selection.status === 'exists') {
      return `${selection.key}: already ${describePublicationStatus(selection.publicationStatus)}`;
    }
    if (selection.status === 'empty') {
      return `${selection.key}: no matching posts, nothing was scheduled`;
    }
    if (selection.status === 'first_send_pending') {
      return `${selection.key}: skipped until firstSendAt ${selection.firstSendAt}. Use -force to publish earlier.`;
    }
    return `${selection.key}: ${selection.status}`;
  });
  if (job) {
    lines.push(formatPublishWorkerStatus(job, requested));
  } else if (!requested) {
    lines.push('No new publication request was created. Worker was not started.');
  }
  return lines.join('\n');
}

function formatPublishWorkerStatus(job, requestCreated) {
  if (requestCreated && job.status === 'skipped' && job.reason === 'duplicate_job') {
    return 'Worker is already running. The created publication request will be processed by the active worker.';
  }
  if (requestCreated && job.status === 'scheduled') {
    return 'Worker is already running. A follow-up worker run was queued and will process the created publication request after the current operation.';
  }
  if (requestCreated && job.status === 'busy') {
    return 'Worker is busy. The created publication request will be processed when the worker runs.';
  }
  return `Worker job status: ${job.status}${job.reason ? ` (${job.reason})` : ''}`;
}

function describePublicationStatus(status) {
  if (status === 'published') return 'published. Nothing was scheduled.';
  if (status === 'created') return 'scheduled and waiting for the worker.';
  if (status === 'running') return 'being published now.';
  return status || 'scheduled';
}

function formatPublishHelp() {
  return [
    'Usage: /publish <selection...> [--force]',
    '',
    'Examples:',
    '/publish daily_best',
    '/publish best.*',
    '/publish controversial.*',
    '/publish best.daily_best controversial.daily_controversial',
    '/publish best.daily_best --force',
    '',
    'Selections: template key, source.key, best.*, or controversial.*.'
  ].join('\n');
}

function formatBotError(error) {
  return `Command failed: ${error?.message || String(error)}`;
}
