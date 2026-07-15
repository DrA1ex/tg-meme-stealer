import { Telegraf } from 'telegraf';
import { formatSelectionHeader } from '../core/format.js';
import { getLogger } from '../core/logger.js';
import { buildSelectionSpecs, loadSelection } from '../core/selection.js';
import { JobGate } from '../runtime/jobGate.js';
import { getLocalTimestampBucket } from '../runtime/scheduler.js';
import { withBotApiRetry } from './retry.js';
import { classifyTelegramError, getTelegramErrorScope, runWithTelegramFailurePolicy } from './errorPolicy.js';
import { PublicationLeaseGuard } from './publicationLease.js';
import { AdminCommandController } from './adminCommands.js';
import { BotLifecycle } from './botLifecycle.js';
import { sendRichPost } from './richPost.js';

export class SelectionPublisher {
  constructor({
    repository,
    mediaDownloader,
    setupAssistant,
    syncWorker = null,
    jobGate = new JobGate(),
    config,
    botRateLimiter = null,
    signal = null,
    restartHandler = null,
    fatalBotErrorHandler = null
  }) {
    this.repository = repository;
    this.mediaDownloader = mediaDownloader;
    this.setupAssistant = setupAssistant;
    this.syncWorker = syncWorker;
    this.jobGate = jobGate;
    this.config = config;
    this.botRateLimiter = botRateLimiter;
    this.signal = signal;
    this.restartHandler = restartHandler || defaultRestartHandler;
    this.bot = new Telegraf(config.telegram.botToken);
    this.logger = getLogger('publisher');
    this.activeHandlers = 0;
    this.backgroundTasks = new Set();
    this.idleResolvers = [];
    this.processingPublications = false;
    this.workerId = getPublisherWorkerId();
    this.workerLeaseMs = Math.max(1, Number(config.publish?.workerLeaseMs) || 900_000);
    this.botLifecycle = new BotLifecycle({
      getBot: () => this.bot,
      pollingLockFile: config.telegram.pollingLockFile,
      logger: this.logger,
      waitForIdle: (timeoutMs) => this.waitForIdle(timeoutMs),
      fatalErrorHandler: fatalBotErrorHandler
    });
    this.configureCommands();
  }

  configureCommands() {
    this.adminCommands = new AdminCommandController({
      repository: this.repository,
      syncWorker: this.syncWorker,
      config: this.config,
      logger: this.logger,
      backgroundTasks: this.backgroundTasks,
      resolveIdle: () => this.resolveIdle(),
      publishAll: (...args) => this.publishAll(...args),
      planManualPublication: (...args) => this.planManualPublication(...args),
      runPublicationWorker: (...args) => this.runPublicationWorker(...args),
      restartHandler: this.restartHandler
    });
    this.adminCommands.register(this.bot, {
      setupAssistant: this.setupAssistant,
      onHandlerStart: () => { this.activeHandlers += 1; },
      onHandlerEnd: () => {
        this.activeHandlers -= 1;
        this.resolveIdle();
      }
    });
  }

  getAdminCommands() {
    this.adminCommands.logger = this.logger;
    this.adminCommands.syncWorker = this.syncWorker;
    return this.adminCommands;
  }

  async handleBotError(error, ctx) {
    return this.getAdminCommands().handleBotError(error, ctx);
  }

  async publishAll(now = new Date(), keys = null, options = {}) {
    return this.planPublicationRequests(now, keys, options);
  }

  planManualPublication(now = new Date(), keys = null, options = {}) {
    const operation = () => this.planPublicationRequests(now, keys, { ...options, source: 'admin' });
    if (typeof this.jobGate.runIfIdle === 'function') {
      return this.jobGate.runIfIdle('publish-plan:manual', operation);
    }
    return { status: 'running', key: 'publish-plan:manual', promise: Promise.resolve().then(operation) };
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
    if (this.syncWorker && !this.syncWorker.canPublish()) {
      const reason = this.syncWorker.getPublicationPauseReason?.() || 'Synchronization has not completed successfully';
      this.logger.warn('Publication planning blocked', { reason });
      return { failed: true, paused: true, reason, selections: [] };
    }
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
      return { skipped: true, reason: 'already_running' };
    }
    if (this.syncWorker && !this.syncWorker.canPublish()) {
      const reason = this.syncWorker.getPublicationPauseReason?.() || 'Synchronization is paused';
      this.logger.warn('Publication worker paused', { reason });
      return { paused: true, reason };
    }

    this.processingPublications = true;
    let processed = 0;
    try {
      while (true) {
        if (this.syncWorker && !this.syncWorker.canPublish()) break;
        const request = await this.repository.getNextPublicationRequest({
          requestTtlHours: getPublicationRequestTtlHours(this.config),
          ownerId: this.workerId,
          leaseMs: this.workerLeaseMs
        });
        if (!request) break;

        const lease = new PublicationLeaseGuard({
          repository: this.repository,
          publicationId: request.id,
          ownerId: this.workerId,
          leaseMs: this.workerLeaseMs,
          signal: this.signal,
          logger: this.logger
        }).start();
        try {
          await this.processPublicationRequest(request, lease);
          processed += 1;
        } catch (error) {
          const classification = classifyTelegramError(error);
          if (classification === 'lease_lost') {
            this.logger.warn('Publication request stopped after lease loss', {
              publicationId: request.id,
              key: request.key
            });
            continue;
          }
          this.logger.error('Unexpected publication request failure', {
            publicationId: request.id,
            key: request.key,
            classification,
            error: error?.message || String(error)
          });
          try {
            await this.handleUnexpectedPublicationFailure(request, error, classification);
          } catch (updateError) {
            if (classifyTelegramError(updateError) !== 'lease_lost') throw updateError;
          }
        } finally {
          await lease.stop();
        }
      }
      return { processed };
    } finally {
      this.processingPublications = false;
    }
  }

  async handleUnexpectedPublicationFailure(request, error, classification = classifyTelegramError(error)) {
    if (classification === 'indeterminate') {
      await this.repository.markPublicationUncertain?.(request.id, this.workerId, error);
      await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) requires manual review because an unexpected delivery outcome is unknown.`);
      return { uncertain: true };
    }
    if (classification === 'cancelled') {
      await this.repository.releasePublicationLease?.(request.id, this.workerId, error);
      return { cancelled: true };
    }
    if (classification === 'permanent') {
      await this.repository.failPublication(request.id, error, this.workerId);
      await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) failed with a definitive error: ${error?.message || String(error)}`);
      return { failed: true };
    }

    const network = classification === 'network';
    const retry = await this.repository.deferPublicationRetry(request.id, this.workerId, error, {
      delayMs: getRequestRetryDelay(this.config, Number(request.attemptCount || 0) + 1),
      maxAttempts: network ? Number.POSITIVE_INFINITY : getRequestMaxRetries(this.config),
      countAttempt: !network
    });
    if (retry.failed) {
      await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) failed after repeated unexpected errors: ${error?.message || String(error)}`);
    }
    return { deferred: !retry.failed, failed: retry.failed, network };
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

  async processPublicationRequest(request, lease = createNoopLease(this.signal)) {
    const selection = request.data?.selection;
    if (!selection?.posts?.length) {
      await this.repository.failPublication(request.id, new Error('Publication request has no selection snapshot'), this.workerId);
      return { failed: true, reason: 'missing_snapshot' };
    }

    if (this.config.publish.dryRun) {
      this.logger.info('Selection dry-run', {
        selection: selection.key,
        title: selection.title,
        posts: selection.posts.length,
        targetChatId: this.config.telegram.publishChannelId
      });
      await this.recordPublication(request.id, selection, 'dry_run', { key: request.key }, this.workerId);
      return { dryRun: true };
    }

    if (request.status === 'header_sending') {
      return this.markRecoveredDeliveryUncertain(
        request,
        new Error('Recovered publication with an indeterminate selection-header delivery')
      );
    }

    if (request.status === 'header_delivered') {
      await this.repository.markPublicationRunning(request.id, this.workerId);
      request.status = 'running';
    }

    if (request.status === 'created') {
      const headerResult = await this.sendPublicationHeader(request, selection, lease);
      if (headerResult?.stopped) return headerResult;
    }

    let rows = await this.repository.listPublicationPosts(request.id);
    for (const delivered of rows.filter((row) => row.sendState === 'delivered')) {
      const post = selection.posts[delivered.position - 1];
      if (!post) {
        const error = new Error(`Delivered publication row has no snapshot post at position ${delivered.position}`);
        error.code = 'PUBLICATION_SNAPSHOT_MISMATCH';
        throw error;
      }
      if (typeof this.repository.markPublicationPostSent === 'function') {
        await this.repository.markPublicationPostSent({
          publicationId: request.id,
          post,
          position: delivered.position,
          botMessageId: delivered.botMessageId,
          ownerId: this.workerId
        });
      }
    }
    if (rows.some((row) => row.sendState === 'delivered')) {
      rows = await this.repository.listPublicationPosts(request.id);
    }

    const interrupted = rows.find((row) => row.sendState === 'sending');
    if (interrupted) {
      return this.markRecoveredDeliveryUncertain(
        request,
        new Error(`Recovered publication with an indeterminate post delivery at position ${interrupted.position}`),
        { position: interrupted.position }
      );
    }

    const rowByPosition = new Map(rows.map((row) => [row.position, row]));
    let consecutiveFailures = 0;
    let skippedPosts = rows.filter((row) => row.sendState === 'failed').length;

    for (let index = 0; index < selection.posts.length; index += 1) {
      const position = index + 1;
      const existing = rowByPosition.get(position);
      if (existing?.sendState === 'sent') {
        consecutiveFailures = 0;
        continue;
      }
      if (existing?.sendState === 'failed') {
        if (existing.lastErrorCode === 'unknown_exhausted') {
          consecutiveFailures += 1;
          if (consecutiveFailures > getMaxConsecutivePostFailures(this.config)) {
            return this.failPublicationForPostStreak(request, consecutiveFailures, position, existing.lastError);
          }
        } else {
          consecutiveFailures = 0;
        }
        continue;
      }

      lease.assertActive();
      const post = selection.posts[index];
      let result;
      try {
        result = await runWithTelegramFailurePolicy(
          () => this.publishPost(
            post,
            index,
            async () => {
              lease.assertActive();
              await this.repository.markPublicationPostSending?.({
                publicationId: request.id,
                post,
                position,
                ownerId: this.workerId
              });
            },
            lease.signal,
            async ({ error }) => {
              lease.assertActive();
              await this.repository.markPublicationPostPending?.({
                publicationId: request.id,
                post,
                position,
                error,
                ownerId: this.workerId
              });
            }
          ),
          {
            label: `publish post ${position}`,
            maxUnknownRetries: getPostMaxRetries(this.config),
            maxNetworkRetries: 0,
            baseDelayMs: this.config.publish?.retryBaseMs,
            maxDelayMs: this.config.publish?.retryMaxMs,
            signal: lease.signal,
            onError: async ({ error, classification }) => {
              if (!['indeterminate', 'lease_lost'].includes(classification)) {
                await this.repository.markPublicationPostPending?.({
                  publicationId: request.id,
                  post,
                  position,
                  error,
                  ownerId: this.workerId
                });
              }
            },
            onRetry: ({ classification, retry, delayMs, error }) => this.logger.warn('Publication post retry scheduled', {
              publicationId: request.id,
              position,
              classification,
              retry,
              delayMs,
              error: error?.message || String(error)
            })
          }
        );
      } catch (error) {
        const classification = classifyTelegramError(error);
        if (classification === 'lease_lost') throw error;
        if (classification === 'indeterminate') {
          await this.repository.markPublicationUncertain(request.id, this.workerId, error);
          await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) requires manual review because delivery of post ${position} may have completed before an interruption. Automatic retries were stopped.`);
          return { stopped: true, uncertain: true, position };
        }
        if (classification === 'cancelled') {
          await this.repository.releasePublicationLease?.(request.id, this.workerId, error);
          return { stopped: true, cancelled: true };
        }
        if (classification === 'network') {
          const retry = await this.repository.deferPublicationRetry(request.id, this.workerId, error, {
            delayMs: getRequestRetryDelay(this.config, 1),
            maxAttempts: Number.POSITIVE_INFINITY,
            countAttempt: false,
            status: 'running'
          });
          this.logger.warn('Publication deferred until Telegram connectivity recovers', {
            publicationId: request.id,
            position,
            nextAttemptAt: retry.nextAttemptAt,
            error: error?.message || String(error)
          });
          return { stopped: true, deferred: true, network: true };
        }

        const scope = getTelegramErrorScope(error, 'post');
        if (classification === 'permanent' && scope !== 'post') {
          await this.repository.failPublication(request.id, error, this.workerId);
          await this.safeNotifyAdmin([
            `Publication ${request.id} (${request.key}) stopped at post ${position}.`,
            `The ${scope} Telegram resource is unavailable: ${error?.message || String(error)}`,
            `Use /publication ${request.id} for details. Resolve the channel/session problem, run /sync, then start a new /publish command.`
          ].join('\n'));
          return { stopped: true, failed: true, scope, position };
        }

        await this.repository.markPublicationPostFailed({
          publicationId: request.id,
          post,
          position,
          error,
          ownerId: this.workerId
        });
        skippedPosts += 1;
        const countsTowardsFailureStreak = classification === 'unknown_exhausted';
        consecutiveFailures = countsTowardsFailureStreak ? consecutiveFailures + 1 : 0;
        this.logger.error('Publication post skipped after definitive or exhausted error', {
          publicationId: request.id,
          position,
          classification,
          scope,
          countsTowardsFailureStreak,
          consecutiveFailures,
          error: error?.message || String(error)
        });
        if (countsTowardsFailureStreak && consecutiveFailures > getMaxConsecutivePostFailures(this.config)) {
          return this.failPublicationForPostStreak(request, consecutiveFailures, position, error);
        }
        continue;
      }

      lease.assertActive();
      const botMessageId = getBotMessageId(result);
      if (typeof this.repository.markPublicationPostDelivered !== 'function'
          || typeof this.repository.markPublicationPostSent !== 'function') {
        await this.repository.recordPublicationPost({
          publicationId: request.id,
          post,
          position,
          botMessageId,
          ownerId: this.workerId
        });
        consecutiveFailures = 0;
        continue;
      }
      try {
        await this.repository.markPublicationPostDelivered({
          publicationId: request.id,
          post,
          position,
          botMessageId,
          ownerId: this.workerId
        });
      } catch (error) {
        error.telegramDeliveryConfirmed = true;
        try {
          await this.repository.markPublicationUncertain(request.id, this.workerId, error);
        } catch (stateError) {
          this.logger.error('Failed to persist uncertain state after confirmed Telegram delivery', {
            publicationId: request.id,
            position,
            error: stateError?.message || String(stateError)
          });
        }
        await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) delivered post ${position} to Telegram, but failed to persist the delivery checkpoint. Automatic sending stopped to prevent a duplicate.`);
        return { stopped: true, uncertain: true, position, deliveryConfirmed: true };
      }

      try {
        await this.repository.markPublicationPostSent({
          publicationId: request.id,
          post,
          position,
          botMessageId,
          ownerId: this.workerId
        });
      } catch (error) {
        const retry = await this.repository.deferPublicationRetry(request.id, this.workerId, error, {
          delayMs: getRequestRetryDelay(this.config, Number(request.attemptCount || 0) + 1),
          maxAttempts: getRequestMaxRetries(this.config),
          countAttempt: true,
          status: 'running'
        });
        if (retry.failed) {
          await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) delivered post ${position}, but repeatedly failed to finalize its database state. The publication is now failed; do not force-retry it without checking the target channel.`);
        }
        return { stopped: true, deferred: !retry.failed, failed: retry.failed, deliveryConfirmed: true };
      }
      consecutiveFailures = 0;
    }

    await this.recordPublication(request.id, selection, 'published', {
      key: request.key,
      skippedPosts
    }, this.workerId);
    if (skippedPosts > 0) {
      await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) completed with ${skippedPosts} skipped post(s). Use /publication ${request.id} for details.`);
    }
    return { published: true, skippedPosts };
  }

  async sendPublicationHeader(request, selection, lease) {
    this.logger.info('Publishing selection header', {
      publicationId: request.id,
      selection: selection.key,
      title: selection.title,
      posts: selection.posts.length,
      targetChatId: this.config.telegram.publishChannelId,
      key: request.key
    });

    let result;
    try {
      result = await runWithTelegramFailurePolicy(
        () => withBotApiRetry(
          () => this.bot.telegram.sendMessage(this.config.telegram.publishChannelId, formatSelectionHeader(selection.title)),
          {
            label: 'sendSelectionHeader',
            rateLimiter: this.botRateLimiter,
            chatId: this.config.telegram.publishChannelId,
            operationTimeoutMs: this.config.rateLimit?.telegramOperationTimeoutMs,
            signal: lease.signal,
            onBeforeOperation: async () => {
              lease.assertActive();
              await this.repository.markPublicationHeaderSending(request.id, this.workerId);
            },
            onRetryableError: async ({ error }) => {
              await this.repository.resetPublicationHeaderForRetry?.(request.id, this.workerId, error);
            }
          }
        ),
        {
          label: 'publish selection header',
          maxUnknownRetries: getRequestMaxRetries(this.config),
          maxNetworkRetries: 0,
          baseDelayMs: this.config.publish?.retryBaseMs,
          maxDelayMs: this.config.publish?.retryMaxMs,
          signal: lease.signal,
          onError: async ({ error, classification }) => {
            if (!['indeterminate', 'lease_lost'].includes(classification)) {
              await this.repository.resetPublicationHeaderForRetry?.(request.id, this.workerId, error);
            }
          }
        }
      );
    } catch (error) {
      const classification = classifyTelegramError(error);
      if (classification === 'lease_lost') throw error;
      if (classification === 'indeterminate') {
        await this.repository.markPublicationUncertain(request.id, this.workerId, error);
        await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) requires manual review because the header delivery outcome is unknown.`);
        return { stopped: true, uncertain: true };
      }
      if (classification === 'cancelled') {
        await this.repository.releasePublicationLease?.(request.id, this.workerId, error);
        return { stopped: true, cancelled: true };
      }
      if (classification === 'permanent' || classification === 'unknown_exhausted') {
        await this.repository.failPublication(request.id, error, this.workerId);
        await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) failed while sending its header: ${error?.message || String(error)}`);
        return { stopped: true, failed: true };
      }

      const retry = await this.repository.deferPublicationRetry(request.id, this.workerId, error, {
        delayMs: getRequestRetryDelay(this.config, Number(request.attemptCount || 0) + 1),
        maxAttempts: Number.POSITIVE_INFINITY,
        countAttempt: false,
        status: 'created'
      });
      return { stopped: true, deferred: true, network: true, nextAttemptAt: retry.nextAttemptAt };
    }

    lease.assertActive();
    if (typeof this.repository.markPublicationHeaderDelivered !== 'function') {
      await this.repository.markPublicationRunning(request.id, this.workerId);
      return { sent: true };
    }
    try {
      await this.repository.markPublicationHeaderDelivered(request.id, this.workerId, getBotMessageId(result));
    } catch (error) {
      try {
        await this.repository.markPublicationUncertain(request.id, this.workerId, error);
      } catch (stateError) {
        this.logger.error('Failed to persist uncertain state after confirmed header delivery', {
          publicationId: request.id,
          error: stateError?.message || String(stateError)
        });
      }
      await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) delivered its header, but failed to persist the delivery checkpoint. Automatic retries stopped to prevent a duplicate header.`);
      return { stopped: true, uncertain: true, deliveryConfirmed: true };
    }

    try {
      await this.repository.markPublicationRunning(request.id, this.workerId);
    } catch (error) {
      const retry = await this.repository.deferPublicationRetry(request.id, this.workerId, error, {
        delayMs: getRequestRetryDelay(this.config, Number(request.attemptCount || 0) + 1),
        maxAttempts: getRequestMaxRetries(this.config),
        countAttempt: true,
        status: 'header_delivered'
      });
      if (retry.failed) {
        await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) sent its header but repeatedly failed to finalize the database state. Check the channel before retrying.`);
      }
      return { stopped: true, deferred: !retry.failed, failed: retry.failed, deliveryConfirmed: true };
    }
    return { sent: true };
  }

  async markRecoveredDeliveryUncertain(request, error, extra = {}) {
    await this.repository.markPublicationUncertain?.(request.id, this.workerId, error);
    this.logger.warn('Publication requires manual review after interrupted delivery', {
      publicationId: request.id,
      key: request.key,
      ...extra
    });
    await this.safeNotifyAdmin(`Publication ${request.id} (${request.key}) was interrupted during delivery and requires manual review. Automatic retries were stopped.`);
    return { stopped: true, uncertain: true };
  }

  async failPublicationForPostStreak(request, consecutiveFailures, position, error) {
    const failure = error instanceof Error
      ? error
      : new Error(`More than ${getMaxConsecutivePostFailures(this.config)} consecutive posts failed near position ${position}: ${error || 'unknown error'}`);
    await this.repository.failPublication(request.id, failure, this.workerId);
    await this.safeNotifyAdmin([
      `Publication ${request.id} (${request.key}) failed.`,
      `${consecutiveFailures} consecutive posts could not be sent; the configured maximum is ${getMaxConsecutivePostFailures(this.config)}.`,
      `Last position: ${position}.`,
      `Use /publication ${request.id} for details.`
    ].join('\n'));
    return { stopped: true, failed: true, consecutiveFailures };
  }

  async publishPost(post, index, onBeforeSend, signal = this.signal, onRetryableError = null) {
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
      templates: this.config.templates,
      rateLimiter: this.botRateLimiter,
      operationTimeoutMs: this.config.rateLimit?.telegramOperationTimeoutMs,
      signal,
      onBeforeSend,
      onRetryableError
    });
  }

  async recordPublication(publicationId, selection, status, data = {}, ownerId = null) {
    await this.repository.finishPublication(publicationId, {
      status,
      posts: selection.posts,
      data: { count: selection.posts.length, ...data },
      ownerId
    });
  }

  async replyJobs(ctx) {
    return this.getAdminCommands().replyJobs(ctx);
  }

  async replyPublications(ctx) {
    return this.getAdminCommands().replyPublications(ctx);
  }

  async replyPublication(ctx) {
    return this.getAdminCommands().replyPublication(ctx);
  }

  async runManualSync(ctx) {
    return this.getAdminCommands().runManualSync(ctx);
  }

  async runManualBackfill(ctx) {
    return this.getAdminCommands().runManualBackfill(ctx);
  }

  scheduleManualJobResult(ctx, label, job) {
    return this.getAdminCommands().scheduleManualJobResult(ctx, label, job);
  }

  async replyManualJobResult(ctx, label, job) {
    return this.getAdminCommands().replyManualJobResult(ctx, label, job);
  }

  async runManualPublish(ctx) {
    return this.getAdminCommands().runManualPublish(ctx);
  }

  async safeNotifyAdmin(message, options = {}) {
    try {
      await this.notifyAdmin(message, options);
      return true;
    } catch (error) {
      this.logger.error('Failed to notify admin', { error: error?.message || String(error) });
      return false;
    }
  }

  async notifyAdmin(message, { bypassRateLimiter = false } = {}) {
    if (!message) return;
    return withBotApiRetry(
      () => this.bot.telegram.sendMessage(this.config.telegram.adminId, String(message)),
      {
        label: 'notifyAdmin',
        rateLimiter: bypassRateLimiter ? null : this.botRateLimiter,
        chatId: this.config.telegram.adminId,
        operationTimeoutMs: this.config.rateLimit?.telegramOperationTimeoutMs,
        signal: this.signal,
        maxRetries: 2
      }
    );
  }

  async runRestart(ctx) {
    return this.getAdminCommands().runRestart(ctx);
  }

  setFatalBotErrorHandler(handler) {
    this.botLifecycle.setFatalErrorHandler(handler);
  }

  get botLaunchPromise() {
    return this.botLifecycle.launchPromise;
  }

  async launchBot() {
    this.logger.debug('Launching bot polling', {
      adminId: this.config.telegram.adminId,
      publishChannelId: this.config.telegram.publishChannelId
    });
    const result = await this.botLifecycle.launch();
    this.logger.info('Bot preflight succeeded; polling launch requested');
    return result;
  }

  reportFatalBotError(error) {
    this.botLifecycle.reportFatalError(error);
  }

  async stopBot(signal = 'SIGTERM', timeoutMs = 30000) {
    this.logger.debug('Stopping bot polling', { signal });
    await this.botLifecycle.stop(signal, timeoutMs);
    this.logger.debug('Bot polling stopped');
  }

  async waitForIdle(timeoutMs = 30000) {
    if (this.activeHandlers === 0 && this.backgroundTasks.size === 0) return;

    let idleResolver;
    const idle = new Promise((resolve) => {
      idleResolver = resolve;
      this.idleResolvers.push(idleResolver);
    });
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([idle, timeout]);
    clearTimeout(timeoutId);
    if (result === 'timeout') {
      this.idleResolvers = this.idleResolvers.filter((resolve) => resolve !== idleResolver);
      this.logger.warn('Timed out waiting for bot work to finish', {
        activeHandlers: this.activeHandlers,
        backgroundTasks: this.backgroundTasks.size,
        timeoutMs
      });
    }
  }

  resolveIdle() {
    if (this.activeHandlers !== 0 || this.backgroundTasks.size !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}

function getPostMaxRetries(config) {
  return nonNegativeInteger(config.publish?.postMaxRetries, 3);
}

function getMaxConsecutivePostFailures(config) {
  return nonNegativeInteger(config.publish?.maxConsecutivePostFailures, 3);
}

function getRequestMaxRetries(config) {
  return nonNegativeInteger(config.publish?.requestMaxRetries, 3);
}

function getRequestRetryDelay(config, attempt) {
  const base = positiveNumber(config.publish?.retryBaseMs, 1_000);
  const max = positiveNumber(config.publish?.retryMaxMs, 60_000);
  return Math.min(max, base * (2 ** Math.min(10, Math.max(0, attempt - 1))));
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


function createNoopLease(signal = null) {
  return {
    signal,
    assertActive() {
      if (signal?.aborted) throw signal.reason || new Error('Application shutting down');
    },
    async stop() {}
  };
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
  return ['created', 'header_sending', 'header_delivered', 'running', 'uncertain', 'published'].includes(publication?.status);
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

function defaultRestartHandler() {
  process.kill(process.pid, 'SIGTERM');
}

function getPublisherWorkerId() {
  const instance = process.env.pm_id !== undefined ? `pm2:${process.env.pm_id}` : `pid:${process.pid}`;
  return `${instance}:${Math.random().toString(36).slice(2, 10)}`;
}
