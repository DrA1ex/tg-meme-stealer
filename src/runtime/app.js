import { PostRepository } from '../database/postRepository.js';
import { createLogger } from '../core/logger.js';
import { MediaDownloader } from '../telegram/media.js';
import { SelectionPublisher } from '../telegram/publisher.js';
import { TelegramScanner } from '../telegram/scanner.js';
import { SetupAssistant } from '../telegram/setupAssistant.js';
import { startUserClient } from '../telegram/userClient.js';
import { SyncWorker } from './syncWorker.js';

export async function createApp(config) {
  const logger = createLogger(config, 'app');
  logger.info('Initializing app', {
    sourceChatId: config.telegram.sourceChatId,
    publishChannelId: config.telegram.publishChannelId,
    adminId: config.telegram.adminId,
    databasePath: config.database.path,
    sessionFile: config.telegram.sessionFile,
    scheduleEnabled: config.schedule?.enabled,
    timezone: config.schedule?.timezone
  });

  const repository = new PostRepository(config.database.path);
  await repository.init();
  logger.info('Database initialized', { path: config.database.path });

  const userClient = await startUserClient(config);
  logger.info('Telegram user client started', {
    sourceChatId: config.telegram.sourceChatId,
    sessionFile: config.telegram.sessionFile
  });
  const scanner = new TelegramScanner({ client: userClient, repository, config });
  const syncWorker = new SyncWorker({ scanner, config });
  const mediaDownloader = new MediaDownloader({ client: userClient, config });
  const setupAssistant = new SetupAssistant({ scanner, mediaDownloader, config });
  const publisher = new SelectionPublisher({ repository, mediaDownloader, setupAssistant, syncWorker, config });
  let closed = false;

  return {
    repository,
    userClient,
    scanner,
    syncWorker,
    publisher,
    async close() {
      if (closed) return;
      closed = true;
      logger.info('Closing app');
      await safeDestroyUserClient(userClient);
      await repository.close();
      logger.info('App closed');
    }
  };
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

export async function runPublish(config, keys = null) {
  const app = await createApp(config);
  try {
    const result = await app.publisher.publishAll(new Date(), keys);
    console.log(`Publish complete: ${result.map((item) => `${item.key}=${item.count}`).join(', ')}`);
    return result;
  } finally {
    await app.close();
  }
}
