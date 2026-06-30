import { loadConfig } from './src/config/index.js';
import { createLogger } from './src/core/logger.js';
import { createApp, runBackfill, runPublish, runSync, runSyncAndPublish } from './src/runtime/app.js';
import { Scheduler } from './src/runtime/scheduler.js';
import { createSession } from './src/telegram/userClient.js';

const command = process.argv[2] || 'daemon';
const config = loadConfig();
const logger = createLogger(config, 'runtime');
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
  console.log(`Session saved: ${sessionPath}`);
} else if (command === 'sync') {
  await runSync(config);
} else if (command === 'backfill') {
  await runBackfill(config, parseOptionalPositiveInteger(process.argv[3]));
} else if (command === 'publish') {
  await runPublish(config, parseOptionalList(process.argv.slice(3)));
} else if (command === 'sync-and-publish') {
  await runSyncAndPublish(config);
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
    await app.publisher.launchBot();
    if (!shuttingDown) {
      logger.info('Setup bot is running', { adminId: config.telegram.adminId });
      console.log('Setup bot is running. Open admin private chat and run /setup.');
    }
  } catch (error) {
    if (!shuttingDown || !isInterruptedLaunchError(error)) throw error;
  }
} else if (command === 'daemon') {
  const app = await createApp(config);
  const scheduler = new Scheduler(config, {
    sync: async () => {
      const sync = await app.scanner.sync();
      console.log(`Sync complete: initial=${sync.isInitial}, seen=${sync.seen}`);
    },
    publish: async (key) => {
      const publish = await app.publisher.publishAll(new Date(), key);
      console.log(`Publish complete: ${publish.map((item) => `${item.key}:${item.count}`).join(',')}`);
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
    await app.publisher.launchBot();
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

function parseOptionalPositiveInteger(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return number;
}

function parseOptionalList(values) {
  return values.length > 0 ? values : null;
}

function isInterruptedLaunchError(error) {
  return ['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code) ||
    String(error?.message || '').includes('Client network socket disconnected');
}
