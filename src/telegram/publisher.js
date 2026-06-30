import { Telegraf } from 'telegraf';
import { formatSelectionHeader } from '../core/format.js';
import { formatJobs } from '../core/jobs.js';
import { createLogger } from '../core/logger.js';
import { loadSelections } from '../core/selection.js';
import { buildStats, formatStats } from '../core/stats.js';
import { JobGate } from '../runtime/jobGate.js';
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
    this.logger = createLogger(config, 'publisher');
    this.activeHandlers = 0;
    this.idleResolvers = [];
    this.processingPublications = false;
    this.configureCommands();
  }

  configureCommands() {
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
        this.logger.info('Bot command received', {
          command,
          fromId: ctx.from?.id,
          chatId: ctx.chat?.id
        });
      }
      await next();
    });

    this.bot.start((ctx) => ctx.reply('Available commands: /stats, /jobs, /sync, /backfill, /publish, /setup'));
    this.bot.command('stats', async (ctx) => {
      const stats = await buildStats(this.repository, this.config);
      await ctx.reply(formatStats(stats, this.config.templates));
    });
    this.bot.command('jobs', async (ctx) => this.replyJobs(ctx));
    this.bot.command('sync', async (ctx) => this.runManualSync(ctx));
    this.bot.command('backfill', async (ctx) => this.runManualBackfill(ctx));
    this.bot.command('publish', async (ctx) => this.runManualPublish(ctx));
    this.setupAssistant?.register(this.bot);
  }

  async publishAll(now = new Date(), keys = null, options = {}) {
    const selections = await loadSelections(this.repository, this.config, now, keys);
    this.logger.info('Publish cycle started', {
      targetChatId: this.config.telegram.publishChannelId,
      keys: keys || 'all',
      selections: selections.length,
      force: Boolean(options.force)
    });
    const results = [];
    for (const selection of selections) {
      results.push(await this.createPublicationRequest(selection, options));
    }
    return {
      selections: selections.map((selection, index) => ({
        key: selection.key,
        count: selection.posts.length,
        ...results[index]
      }))
    };
  }

  async createPublicationRequest(selection, options = {}) {
    if (selection.posts.length === 0) {
      this.logger.info('Selection skipped: no posts', { selection: selection.key });
      return { status: 'empty', requested: false };
    }

    const canonicalKey = getPublicationKey(selection, this.config);
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
      const existing = await this.repository.getPublicationByKey(canonicalKey);
      this.logger.info('Selection skipped: request already exists', {
        selection: selection.key,
        key: canonicalKey,
        status: existing?.status
      });
      return {
        status: existing?.status ? 'exists' : 'duplicate',
        requested: false,
        publicationId: existing?.id || null,
        publicationStatus: existing?.status || '',
        publicationKey: canonicalKey
      };
    }
    this.logger.info('Publication request created', { publicationId, selection: selection.key, key, posts: selection.posts.length });
    return {
      status: 'scheduled',
      requested: true,
      publicationId,
      publicationKey: key,
      forced: Boolean(options.force)
    };
  }

  async processPublicationQueue() {
    if (this.processingPublications) {
      this.logger.info('Publication worker skipped: already running');
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
    return this.jobGate.run('publish', () => this.executePublicationWorker(source));
  }

  async executePublicationWorker(source) {
    this.logger.info('Publication worker job started', { source });
    try {
      await this.processPublicationQueue();
      this.logger.info('Publication worker job finished', { source });
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
          this.logger.info('Publication post skipped: already sent', {
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
    await ctx.reply(formatJobs(jobs), { parse_mode: 'Markdown' });
  }

  async runManualSync(ctx) {
    if (!this.syncWorker) {
      await ctx.reply('Sync worker is not available.');
      return;
    }
    const job = await this.syncWorker.sync('admin');
    await ctx.reply(formatJobStatus('Sync', job));
  }

  async runManualBackfill(ctx) {
    if (!this.syncWorker) {
      await ctx.reply('Sync worker is not available.');
      return;
    }
    const days = parseOptionalPositiveInteger(getCommandArgument(ctx));
    const job = await this.syncWorker.backfill(days, 'admin');
    await ctx.reply(formatJobStatus('Backfill', job));
  }

  async runManualPublish(ctx) {
    const args = getCommandArguments(ctx);
    const force = args.includes('--force');
    const keys = args.filter((arg) => arg !== '--force');
    const result = await this.publishAll(new Date(), keys.length > 0 ? keys : null, { force });
    const job = result.selections.some((selection) => selection.requested)
      ? this.runPublicationWorker('admin')
      : null;
    await ctx.reply(formatPublishResult(result, job));
  }

  launchBot() {
    this.logger.info('Launching bot polling', {
      adminId: this.config.telegram.adminId,
      publishChannelId: this.config.telegram.publishChannelId
    });
    void this.bot.launch()
      .then(() => {
        this.logger.info('Bot polling finished');
      })
      .catch((error) => {
        this.logger.error('Bot polling failed', { error: error?.message || String(error) });
      });
    this.logger.info('Bot polling launch requested');
  }

  async stopBot(signal = 'SIGTERM') {
    this.logger.info('Stopping bot polling', { signal });
    try {
      this.bot.stop(signal);
    } catch (error) {
      if (!isBotAlreadyStoppedError(error)) throw error;
    }
    await this.waitForIdle();
    this.logger.info('Bot polling stopped');
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
    selection.key,
    getPublicationBucket(selection.period, new Date(selection.untilIso), config.schedule?.timezone || 'UTC')
  ].join(':');
}

function getForcedPublicationKey(selection, config) {
  return [
    'publish',
    'force',
    randomCode(),
    selection.key,
    getPublicationBucket(selection.period, new Date(selection.untilIso), config.schedule?.timezone || 'UTC')
  ].join(':');
}

function getPublicationBucket(period, date, timezone) {
  const parts = getLocalDateParts(date, timezone);
  if (period === 'month') return `${parts.year}-${pad2(parts.month)}`;
  if (period === 'week') return `${parts.year}-W${pad2(getIsoWeek(parts))}`;
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getLocalDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function getIsoWeek(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function pad2(value) {
  return String(value).padStart(2, '0');
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

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return number;
}

function formatJobStatus(label, job) {
  if (job.status === 'skipped' || job.status === 'busy') {
    return `${label} job status: ${job.status} (${job.reason})`;
  }
  return `${label} job status: ${job.status}`;
}

function formatPublishResult(result, job = null) {
  const lines = result.selections.map((selection) => {
    if (selection.status === 'scheduled') {
      return `${selection.key}: scheduled (${selection.count})${selection.forced ? ' forced' : ''}`;
    }
    if (selection.status === 'exists') {
      return `${selection.key}: already ${selection.publicationStatus || 'scheduled'}`;
    }
    if (selection.status === 'empty') {
      return `${selection.key}: no posts`;
    }
    return `${selection.key}: ${selection.status}`;
  });
  if (job) {
    lines.push(`Worker job status: ${job.status}${job.reason ? ` (${job.reason})` : ''}`);
  }
  return lines.join('\n') || 'No selections matched.';
}
