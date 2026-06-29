import { PostRepository } from '../database/postRepository.js';
import { MediaDownloader } from '../telegram/media.js';
import { SelectionPublisher } from '../telegram/publisher.js';
import { TelegramScanner } from '../telegram/scanner.js';
import { SetupAssistant } from '../telegram/setupAssistant.js';
import { startUserClient } from '../telegram/userClient.js';

export async function createApp(config) {
  const repository = new PostRepository(config.database.path);
  await repository.init();

  const userClient = await startUserClient(config);
  const scanner = new TelegramScanner({ client: userClient, repository, config });
  const mediaDownloader = new MediaDownloader({ client: userClient, config });
  const setupAssistant = new SetupAssistant({ scanner, mediaDownloader, config });
  const publisher = new SelectionPublisher({ repository, mediaDownloader, setupAssistant, config });
  let closed = false;

  return {
    repository,
    userClient,
    scanner,
    publisher,
    async close() {
      if (closed) return;
      closed = true;
      await safeDestroyUserClient(userClient);
      await repository.close();
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

export async function runSync(config) {
  const app = await createApp(config);
  try {
    const result = await app.scanner.sync();
    console.log(`Sync complete: initial=${result.isInitial}, since=${result.since}, seen=${result.seen}`);
    return result;
  } finally {
    await app.close();
  }
}

export async function runPublish(config) {
  const app = await createApp(config);
  try {
    const result = await app.publisher.publishAll();
    console.log(`Publish complete: ${result.map((item) => `${item.key}=${item.count}`).join(', ')}`);
    return result;
  } finally {
    await app.close();
  }
}

export async function runSyncAndPublish(config) {
  const app = await createApp(config);
  try {
    const sync = await app.scanner.sync();
    const publish = await app.publisher.publishAll();
    console.log(`Cycle complete: initial=${sync.isInitial}, seen=${sync.seen}, publish=${publish.map((item) => `${item.key}:${item.count}`).join(',')}`);
    return { sync, publish };
  } finally {
    await app.close();
  }
}
