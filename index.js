import { loadConfig } from './src/config/index.js';
import { createApp, runPublish, runSync, runSyncAndPublish } from './src/runtime/app.js';
import { Scheduler } from './src/runtime/scheduler.js';
import { createSession } from './src/telegram/userClient.js';

const command = process.argv[2] || 'daemon';
const config = loadConfig();

if (command === 'session') {
  const sessionPath = await createSession(config);
  console.log(`Session saved: ${sessionPath}`);
} else if (command === 'sync') {
  await runSync(config);
} else if (command === 'publish') {
  await runPublish(config);
} else if (command === 'sync-and-publish') {
  await runSyncAndPublish(config);
} else if (command === 'setup') {
  const app = await createApp(config);
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      app.publisher.stopBot(signal);
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await app.publisher.launchBot();
  console.log('Setup bot is running. Open admin private chat and run /setup.');
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
    try {
      scheduler.stop();
      app.publisher.stopBot(signal);
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await app.publisher.launchBot();
  await scheduler.start();
} else {
  throw new Error(`Unknown command: ${command}`);
}
