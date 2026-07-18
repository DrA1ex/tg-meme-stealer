import { PostRepository } from '../database/postRepository.js';
import { getLogger, subscribeToErrorLogs } from '../core/logger.js';
import { MediaDownloader } from '../telegram/media.js';
import { BotApiRateLimiter } from '../telegram/botRateLimiter.js';
import { createRedisRateLimitStore } from '../telegram/redisRateLimitStore.js';
import { SelectionPublisher } from '../telegram/publisher.js';
import { TelegramScanner } from '../telegram/scanner.js';
import { TelegramThrottle } from '../telegram/throttle.js';
import { SetupAssistant } from '../telegram/setupAssistant.js';
import { startUserClient } from '../telegram/userClient.js';
import { JobGate } from './jobGate.js';
import { RetentionWorker } from './retentionWorker.js';
import { SyncWorker } from './syncWorker.js';
import { ErrorLogCollector } from './errorLogCollector.js';

export async function createApp(config) {
  const logger = getLogger('app');
  const shutdownController = new AbortController();
  logger.debug('Initializing app', {
    sourceChatId: config.telegram.sourceChatId,
    publishChannelId: config.telegram.publishChannelId,
    adminId: config.telegram.adminId,
    databasePath: config.database.path,
    sessionFile: config.telegram.sessionFile,
    scheduleEnabled: config.schedule?.enabled,
    timezone: config.schedule?.timezone
  });

  let repository;
  let userClient;
  let sharedRateLimitStore;
  let telegramThrottle;
  let botRateLimiter;
  let scanner;
  let jobGate;
  let syncWorker;
  let retentionWorker;
  let mediaDownloader;
  let setupAssistant;
  let publisher;
  let errorLogCollector;
  let errorLogUnsubscribe = null;
  let redisStatusUnsubscribe = null;

  try {
    repository = new PostRepository(config.database.path);
    await repository.init();
    logger.info('Database initialized', { path: config.database.path });
    errorLogCollector = new ErrorLogCollector({ repository });
    errorLogUnsubscribe = subscribeToErrorLogs((event) => errorLogCollector.record(event));

    userClient = await startUserClient(config);
    logger.info('Telegram user client started', {
      sourceChatId: config.telegram.sourceChatId,
      sessionFile: config.telegram.sessionFile
    });
    sharedRateLimitStore = await createRedisRateLimitStore(config);
    telegramThrottle = new TelegramThrottle(config, undefined, undefined, sharedRateLimitStore);
    botRateLimiter = new BotApiRateLimiter(config, undefined, undefined, sharedRateLimitStore);
    scanner = new TelegramScanner({
      client: userClient,
      repository,
      config,
      throttle: telegramThrottle,
      signal: shutdownController.signal
    });
    jobGate = new JobGate();
    syncWorker = new SyncWorker({ scanner, jobGate, config, signal: shutdownController.signal });
    retentionWorker = new RetentionWorker({ scanner, jobGate });
    mediaDownloader = new MediaDownloader({
      client: userClient,
      config,
      throttle: telegramThrottle,
      signal: shutdownController.signal
    });
    setupAssistant = new SetupAssistant({ scanner, mediaDownloader, config, botRateLimiter });
    publisher = new SelectionPublisher({
      repository,
      mediaDownloader,
      setupAssistant,
      syncWorker,
      jobGate,
      config,
      botRateLimiter,
      signal: shutdownController.signal,
      errorLogCollector
    });
    errorLogCollector.setNotifier((message) => publisher.notifyAdmin(message, { bypassRateLimiter: true }));
    errorLogCollector.startDailyDigest({
      time: config.logging?.errorDigestTime || '12:00',
      timezone: config.schedule?.timezone || 'UTC'
    });
    syncWorker.setAdminNotifier((message) => publisher.notifyAdmin(message));
    if (sharedRateLimitStore) {
      let lastAdminStatus = null;
      const reportRedisStatus = ({ status, previous = null } = {}) => {
        if (!status || status === lastAdminStatus) return;
        lastAdminStatus = status;
        if (status === 'degraded') {
          void publisher.safeNotifyAdmin([
            'Shared Redis rate limiter is unavailable.',
            config.rateLimit?.redis?.required === true
              ? 'Redis is required, so Telegram operations are paused until it recovers.'
              : 'The process is using a conservative local fallback. This is not safe as a shared limiter across multiple PM2 instances.',
            'Check Redis connectivity and the rateLimit.redis settings.'
          ].join('\n'), {
            // Redis itself is the failed dependency. Send this one transition alert
            // without the shared limiter so required mode can still reach the admin.
            bypassRateLimiter: true
          });
        } else if (status === 'ready' && previous === 'degraded') {
          void publisher.safeNotifyAdmin('Shared Redis rate limiter recovered; shared Telegram rate limiting is active again.');
        }
      };
      redisStatusUnsubscribe = sharedRateLimitStore.setStatusListener(reportRedisStatus);
      reportRedisStatus({ status: sharedRateLimitStore.health });
    }
  } catch (error) {
    const cleanupErrors = await cleanupInitializedResources({
      botRateLimiter,
      telegramThrottle,
      sharedRateLimitStore,
      userClient,
      errorLogCollector,
      errorLogUnsubscribe,
      repository
    });
    if (cleanupErrors.length) {
      logger.error('App initialization cleanup failed', {
        errors: cleanupErrors.map((item) => item?.message || String(item))
      });
    }
    throw error;
  }
  let resourceClosePromise = null;
  let shutdownPromise = null;

  function beginShutdown(reason = 'shutdown') {
    if (!shutdownController.signal.aborted) {
      const error = new Error(`Application shutting down: ${reason}`);
      error.code = 'APPLICATION_SHUTDOWN';
      shutdownController.abort(error);
    }
    jobGate.close();
    telegramThrottle.close();
    botRateLimiter.close();
    errorLogCollector?.stopDailyDigest();
  }

  function closeResources() {
    if (resourceClosePromise) return resourceClosePromise;
    resourceClosePromise = (async () => {
      logger.debug('Closing app resources');
      redisStatusUnsubscribe?.();
      redisStatusUnsubscribe = null;
      const failures = [];
      const externalResults = await Promise.allSettled([
        safeDestroyUserClient(userClient),
        sharedRateLimitStore?.close()
      ]);
      for (const result of externalResults) {
        if (result.status !== 'rejected') continue;
        failures.push(result.reason);
        logger.error('App resource failed to close', {
          error: result.reason?.message || String(result.reason)
        });
      }

      errorLogUnsubscribe?.();
      errorLogUnsubscribe = null;
      try {
        await errorLogCollector?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await repository.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, 'One or more app resources failed to close');
      }
      logger.debug('App resources closed');
    })();
    return resourceClosePromise;
  }

  return {
    repository,
    userClient,
    scanner,
    jobGate,
    syncWorker,
    retentionWorker,
    publisher,
    errorLogCollector,
    cancelRateLimitWaits() {
      telegramThrottle.close();
      botRateLimiter.close();
    },
    beginShutdown,
    async shutdown(signal = 'SIGTERM') {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        const timeoutMs = positiveNumber(config.shutdown?.timeoutMs, 30_000);
        const closeGraceMs = Math.min(5_000, Math.max(1_000, Math.floor(timeoutMs / 5)));
        const startedAt = Date.now();
        const deadlineAt = startedAt + timeoutMs;
        const drainDeadlineAt = deadlineAt - closeGraceMs;
        beginShutdown(signal);
        logger.info('Application drain started', { signal, timeoutMs, closeGraceMs });

        let drained = false;
        let drainFailed = false;
        try {
          drained = await settleBeforeDeadline(Promise.all([
            publisher.stopBot(signal, Math.max(1, drainDeadlineAt - Date.now())),
            jobGate.waitForIdle()
          ]), drainDeadlineAt);
        } catch (error) {
          drainFailed = true;
          logger.error('Application drain failed; forcing resource close', {
            signal,
            error: error?.message || String(error)
          });
        }
        if (!drained && !drainFailed) {
          logger.warn('Application drain deadline exceeded; forcing resource close', {
            signal,
            elapsedMs: Date.now() - startedAt,
            remainingJob: jobGate.runningKey || '',
            queuedJobs: jobGate.queue.length
          });
        }

        let resourcesClosed = false;
        let resourceCloseError = null;
        try {
          resourcesClosed = await settleBeforeDeadline(closeResources(), deadlineAt);
        } catch (error) {
          resourceCloseError = error;
          logger.error('Application resource close failed', {
            signal,
            error: error?.message || String(error)
          });
        }
        if (!resourcesClosed) {
          logger.error('Application resource close deadline exceeded; process will exit', {
            signal,
            timeoutMs,
            elapsedMs: Date.now() - startedAt
          });
        }
        logger.info('Application shutdown finished', {
          signal,
          drained,
          resourcesClosed,
          durationMs: Date.now() - startedAt
        });
        if (resourceCloseError) throw resourceCloseError;
      })();
      return shutdownPromise;
    },
    async close() {
      beginShutdown('close');
      await closeResources();
    }
  };
}


export async function cleanupInitializedResources({
  botRateLimiter,
  telegramThrottle,
  sharedRateLimitStore,
  userClient,
  errorLogCollector,
  errorLogUnsubscribe,
  repository
} = {}) {
  const cleanupSteps = [
    () => safeClose(botRateLimiter),
    () => safeClose(telegramThrottle),
    () => safeClose(sharedRateLimitStore),
    () => userClient ? safeDestroyUserClient(userClient) : undefined,
    () => errorLogUnsubscribe?.(),
    () => safeClose(errorLogCollector),
    () => safeClose(repository)
  ];
  const errors = [];
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export async function settleBeforeDeadline(promise, deadlineAt) {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    Promise.resolve(promise).catch(() => {});
    return false;
  }
  let timeout;
  const result = await Promise.race([
    Promise.resolve(promise).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), remainingMs);
    })
  ]);
  clearTimeout(timeout);
  return result;
}

async function safeClose(resource) {
  if (!resource || typeof resource.close !== 'function') return;
  await resource.close();
}

async function safeDestroyUserClient(userClient) {
  try {
    await userClient.destroy();
  } catch (error) {
    if (!isAlreadyClosedStorageError(error)) throw error;
  }
}

function isAlreadyClosedStorageError(error) {
  return String(error?.message || error).includes('database connection is not open');
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
