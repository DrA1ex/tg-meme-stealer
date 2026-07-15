import { loadConfig } from './src/config/index.js';
import { configureLogger, getLogger } from './src/core/logger.js';
import { createApp } from './src/runtime/app.js';
import { formatScheduledPublishLog } from './src/runtime/publishLog.js';
import { Scheduler } from './src/runtime/scheduler.js';
import { createSession } from './src/telegram/userClient.js';

const command = process.argv[2] || 'daemon';
const config = loadConfig();
configureLogger(config);
const logger = getLogger('runtime');
logger.info('Command starting', {
  command,
  sourceChatId: config.telegram.sourceChatId,
  publishChannelId: config.telegram.publishChannelId,
  adminId: config.telegram.adminId,
  databasePath: config.database.path,
  timezone: config.schedule?.timezone
});

if (command === 'session') {
  const sessionPath = await createSession(config);
  logger.info('Session saved', { sessionPath });
} else if (command === 'setup') {
  const app = await createApp(config);
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown requested', { command, signal });
    try {
      await app.shutdown(signal);
      logger.info('Shutdown complete', { command, signal });
      process.exit(0);
    } catch (error) {
      logger.error('Shutdown failed', { command, signal, error: error?.message || String(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  app.publisher.setFatalBotErrorHandler((error) => {
    logger.error('Bot polling stopped unexpectedly; shutting down', { error: error?.message || String(error) });
    void shutdown('BOT_POLLING_FAILED');
  });
  try {
    await app.publisher.launchBot();
    if (!shuttingDown) {
      logger.info('Setup bot is running', { adminId: config.telegram.adminId });
    }
  } catch (error) {
    if (!(shuttingDown && isInterruptedLaunchError(error))) {
      logger.error('Setup bot launch failed', { error: error?.message || String(error) });
      await app.shutdown('BOT_LAUNCH_FAILED').catch((shutdownError) => {
        logger.error('Cleanup after setup bot launch failure failed', { error: shutdownError?.message || String(shutdownError) });
      });
      throw error;
    }
  }
} else if (command === 'daemon') {
  const app = await createApp(config);
  const scheduler = new Scheduler(config, {
    sync: async () => {
      const job = await app.syncWorker.sync('schedule');
      logger.debug('Scheduled sync job status', { status: job.status, reason: job.reason });
      job.promise.then((sync) => {
        if (!sync?.skipped && !sync?.failed) {
          logger.info('Scheduled sync complete', { initial: sync.isInitial, seen: sync.seen });
        }
      });
      return job;
    },
    publish: async (key, now = new Date()) => {
      const job = app.publisher.schedulePublicationRequestFromSchedule(key, now);
      logger.debug('Scheduled publish enqueue job status', {
        key,
        status: job.status,
        reason: job.reason || ''
      });
      const publish = await job.promise;
      const logFields = formatScheduledPublishLog(publish);
      const log = isEmptyScheduledPublishResult(publish) ? logger.warn : logger.info;
      log('Scheduled publish enqueue complete', logFields);
      return publish;
    },
    publishWorker: async () => {
      const job = app.publisher.runPublicationWorker('schedule');
      logger.debug('Scheduled publish worker job status', { status: job.status, reason: job.reason });
      return job;
    },
    retention: async () => {
      const job = app.retentionWorker.run('schedule');
      logger.debug('Scheduled retention job status', { status: job.status, reason: job.reason });
      return job;
    }
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown requested', { command, signal });
    try {
      scheduler.stop();
      await app.shutdown(signal);
      logger.info('Shutdown complete', { command, signal });
      process.exit(0);
    } catch (error) {
      logger.error('Shutdown failed', { command, signal, error: error?.message || String(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  app.publisher.setFatalBotErrorHandler((error) => {
    logger.error('Bot polling stopped unexpectedly; shutting down', { error: error?.message || String(error) });
    void shutdown('BOT_POLLING_FAILED');
  });
  try {
    await app.publisher.launchBot();
    if (!shuttingDown) {
      logger.info('Daemon bot launched, starting scheduler');
      await scheduler.start();
    }
  } catch (error) {
    if (!(shuttingDown && isInterruptedLaunchError(error))) {
      logger.error('Daemon bot launch failed', { error: error?.message || String(error) });
      scheduler.stop();
      await app.shutdown('BOT_LAUNCH_FAILED').catch((shutdownError) => {
        logger.error('Cleanup after daemon bot launch failure failed', { error: shutdownError?.message || String(shutdownError) });
      });
      throw error;
    }
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}

function isInterruptedLaunchError(error) {
  return ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code) ||
    String(error?.message || '').includes('Client network socket disconnected');
}

function isEmptyScheduledPublishResult(result = {}) {
  const selections = result.selections || [];
  if (selections.length === 0) return false;
  const created = selections.some((selection) => selection.requested || selection.status === 'scheduled');
  return !created && selections.some((selection) => selection.status === 'empty');
}
