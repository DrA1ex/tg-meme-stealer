import { formatJobs } from '../core/jobs.js';
import { formatPublicationPosts, formatPublications } from '../core/publications.js';
import { buildStats, formatStats } from '../core/stats.js';

export class AdminCommandController {
  constructor({
    repository,
    syncWorker,
    config,
    logger,
    backgroundTasks,
    resolveIdle,
    publishAll,
    planManualPublication = null,
    runPublicationWorker,
    restartHandler
  }) {
    this.repository = repository;
    this.syncWorker = syncWorker;
    this.config = config;
    this.logger = logger;
    this.backgroundTasks = backgroundTasks;
    this.resolveIdle = resolveIdle;
    this.publishAll = publishAll;
    this.planManualPublication = planManualPublication;
    this.runPublicationWorker = runPublicationWorker;
    this.restartHandler = restartHandler;
  }

  register(bot, { setupAssistant = null, onHandlerStart, onHandlerEnd } = {}) {
    bot.catch((error, ctx) => this.handleBotError(error, ctx));
    bot.use(async (ctx, next) => {
      onHandlerStart?.();
      try {
        await next();
      } finally {
        onHandlerEnd?.();
      }
    });
    bot.use(async (ctx, next) => {
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

    bot.start((ctx) => ctx.reply('Available commands: /stats, /jobs, /publications, /publication, /sync, /backfill, /publish, /setup, /restart'));
    bot.command('stats', async (ctx) => {
      const stats = await buildStats(this.repository, this.config);
      await ctx.reply(formatStats(stats, this.config.templates));
    });
    bot.command('jobs', async (ctx) => this.replyJobs(ctx));
    bot.command('publications', async (ctx) => this.replyPublications(ctx));
    bot.command('publication', async (ctx) => this.replyPublication(ctx));
    bot.command('sync', async (ctx) => this.runManualSync(ctx));
    bot.command('backfill', async (ctx) => this.runManualBackfill(ctx));
    bot.command('publish', async (ctx) => this.runManualPublish(ctx));
    bot.command('restart', async (ctx) => this.runRestart(ctx));
    setupAssistant?.register(bot);
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
    const args = getCommandArguments(ctx);
    const force = args.some(isForceFlag);
    const unknown = args.filter((arg) => !isForceFlag(arg));
    if (unknown.length) throw new Error('Usage: /sync [--force]');
    const job = await this.syncWorker.sync('admin', { force });
    await ctx.reply(`${formatJobStatus('Sync', job)}${force ? ' (force reconciliation enabled)' : ''}`);
    this.scheduleManualJobResult(ctx, 'Sync', job);
  }

  async runManualBackfill(ctx) {
    if (!this.syncWorker) {
      await ctx.reply('Sync worker is not available.');
      return;
    }
    const days = parseOptionalPositiveInteger(getCommandArgument(ctx));
    const job = await this.syncWorker.backfill(days, 'admin');
    await ctx.reply(formatJobStatus('Backfill', job));
    this.scheduleManualJobResult(ctx, 'Backfill', job);
  }

  scheduleManualJobResult(ctx, label, job) {
    if (!shouldWaitForManualJob(job)) return;
    const task = this.replyManualJobResult(ctx, label, job)
      .catch((error) => {
        this.logger.error('Failed to send manual job result', {
          operation: label.toLowerCase(),
          jobKey: job.key || '',
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
        this.resolveIdle();
      });
    this.backgroundTasks.add(task);
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
    const planningJob = this.planManualPublication
      ? this.planManualPublication(new Date(), keys, { force })
      : null;
    if (planningJob && (planningJob.status === 'busy' || planningJob.status === 'skipped')) {
      await ctx.reply(`Publish planning is ${planningJob.status}: ${planningJob.reason || 'another job is running'}. Try again after the current sync or maintenance job finishes.`);
      return;
    }
    const result = planningJob
      ? await planningJob.promise
      : await this.publishAll(new Date(), keys, { force });
    if (result?.failed) {
      await ctx.reply(`Publish planning failed: ${result.error || result.reason || 'unknown error'}`);
      return;
    }
    const job = result.selections?.some((selection) => selection.requested)
      ? this.runPublicationWorker('admin')
      : null;
    await ctx.reply(formatPublishResult(result, job));
  }

  async runRestart(ctx) {
    await ctx.reply('Restart requested. The process will shut down gracefully and should be started again by the service manager.');
    const task = Promise.resolve()
      .then(() => delay(100))
      .then(() => this.restartHandler())
      .catch((error) => this.logger.error('Restart request failed', { error: error?.message || String(error) }))
      .finally(() => {
        this.backgroundTasks.delete(task);
        this.resolveIdle();
      });
    this.backgroundTasks.add(task);
  }
}

export function getCommandName(ctx) {
  const text = ctx.message?.text || ctx.update?.message?.text || '';
  const match = text.match(/^\/([^\s@]+)(?:@\w+)?/);
  return match?.[1] || '';
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
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected a positive integer, got: ${value}`);
  return number;
}

function parseRequiredPositiveInteger(value, label) {
  const number = parseOptionalPositiveInteger(value);
  if (number === undefined) throw new Error(`Usage: /publication <${label}>`);
  return number;
}

function formatJobStatus(label, job) {
  if (job.status === 'skipped' || job.status === 'busy') return `${label} job status: ${job.status} (${job.reason})`;
  return `${label} job status: ${job.status}`;
}

function shouldWaitForManualJob(job) {
  return Boolean(job?.promise) && (job.status === 'running' || job.status === 'scheduled');
}

async function waitForManualJob(job) {
  try {
    return await job.promise;
  } catch (error) {
    return { failed: true, error: error?.message || String(error) };
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
  if (result.selections.length === 0) return 'No enabled selections matched. Use -force to publish an explicitly disabled selection.';
  const requested = result.selections.some((selection) => selection.requested || selection.status === 'scheduled');
  const lines = result.selections.map((selection) => {
    if (selection.status === 'scheduled') return `${selection.key}: publication request created (${selection.count} posts)${selection.forced ? ' forced' : ''}`;
    if (selection.status === 'exists') return `${selection.key}: already ${describePublicationStatus(selection.publicationStatus)}`;
    if (selection.status === 'empty') return `${selection.key}: no matching posts, nothing was scheduled`;
    if (selection.status === 'first_send_pending') return `${selection.key}: skipped until firstSendAt ${selection.firstSendAt}. Use -force to publish earlier.`;
    return `${selection.key}: ${selection.status}`;
  });
  if (job) lines.push(formatPublishWorkerStatus(job, requested));
  else if (!requested) lines.push('No new publication request was created. Worker was not started.');
  return lines.join('\n');
}

function formatPublishWorkerStatus(job, requestCreated) {
  if (requestCreated && job.status === 'skipped' && job.reason === 'duplicate_job') return 'Worker is already running. The created publication request will be processed by the active worker.';
  if (requestCreated && job.status === 'scheduled') return 'Worker is already running. A follow-up worker run was queued and will process the created publication request after the current operation.';
  if (requestCreated && job.status === 'busy') return 'Worker is busy. The created publication request will be processed when the worker runs.';
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
