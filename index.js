import { loadConfig } from './src/config/index.js';
import { configureLogger, getLogger } from './src/core/logger.js';
import { createApp } from './src/runtime/app.js';
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
      await app.publisher.stopBot(signal);
      await app.close();
      logger.info('Shutdown complete', { command, signal });
      process.exit(0);
    } catch (error) {
      logger.error('Shutdown failed', { command, signal, error: error?.message || String(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  try {
    app.publisher.launchBot();
    if (!shuttingDown) {
      logger.info('Setup bot is running', { adminId: config.telegram.adminId });
    }
  } catch (error) {
    if (!shuttingDown || !isInterruptedLaunchError(error)) throw error;
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
      const publish = await app.publisher.publishAll(now, key);
      logger.info('Scheduled publish planned', {
        selections: publish.selections.map((item) => `${item.key}:${item.status}`).join(',')
      });
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
      await app.publisher.stopBot(signal);
      await app.close();
      logger.info('Shutdown complete', { command, signal });
      process.exit(0);
    } catch (error) {
      logger.error('Shutdown failed', { command, signal, error: error?.message || String(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  try {
    app.publisher.launchBot();
    if (!shuttingDown) {
      logger.info('Daemon bot launched, starting scheduler');
      await scheduler.start();
    }
  } catch (error) {
    if (!shuttingDown || !isInterruptedLaunchError(error)) throw error;
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}

function isInterruptedLaunchError(error) {
  return ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code) ||
    String(error?.message || '').includes('Client network socket disconnected');
}
