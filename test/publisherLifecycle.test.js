import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { SelectionPublisher } from '../src/telegram/publisher.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('publication planning remains blocked during a sync pause even with --force', async () => {
  let repositoryCalls = 0;
  const publisher = createPublisher({
    repository: new Proxy({}, {
      get() {
        repositoryCalls += 1;
        throw new Error('repository must not be used while publication is paused');
      }
    }),
    syncWorker: {
      canPublish: () => false,
      getPublicationPauseReason: () => 'startup sync failed'
    }
  });

  const result = await publisher.planPublicationRequests(new Date('2026-07-15T00:00:00.000Z'), ['best.day'], { force: true });

  assert.deepEqual(result, {
    failed: true,
    paused: true,
    reason: 'startup sync failed',
    selections: []
  });
  assert.equal(repositoryCalls, 0);
});

test('bot launch fails before polling when Telegram preflight fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-bot-preflight-'));
  const lockPath = path.join(tempDir, 'polling.lock');
  const expected = new Error('invalid bot token');
  const publisher = createPublisher({ pollingLockFile: lockPath });
  let launchCalled = false;
  publisher.bot = {
    telegram: { getMe: async () => { throw expected; } },
    launch: () => {
      launchCalled = true;
      return Promise.resolve();
    }
  };

  await assert.rejects(() => publisher.launchBot(), expected);
  assert.equal(launchCalled, false);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('unexpected polling failure is reported once and releases the polling lock', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-bot-fatal-'));
  const lockPath = path.join(tempDir, 'polling.lock');
  const polling = deferred();
  const fatalErrors = [];
  const publisher = createPublisher({
    pollingLockFile: lockPath,
    fatalBotErrorHandler: (error) => fatalErrors.push(error)
  });
  publisher.bot = {
    telegram: { getMe: async () => ({ id: 1 }) },
    launch: () => polling.promise
  };

  await publisher.launchBot();
  await fs.access(lockPath);
  const expected = new Error('polling connection failed');
  polling.reject(expected);
  await waitUntil(() => fatalErrors.length === 1 && publisher.botLaunchPromise === null);

  assert.deepEqual(fatalErrors, [expected]);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
  publisher.reportFatalBotError(new Error('second failure'));
  assert.equal(fatalErrors.length, 1);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('/restart acknowledges the command and invokes the configured restart handler', async () => {
  const replies = [];
  let restarted = 0;
  const publisher = createPublisher({
    restartHandler: async () => {
      restarted += 1;
    }
  });

  await publisher.runRestart({ reply: async (message) => replies.push(message) });
  await publisher.waitForIdle(1_000);

  assert.equal(restarted, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /shut down gracefully/i);
});

function createPublisher({
  repository = {},
  syncWorker = null,
  pollingLockFile,
  restartHandler,
  fatalBotErrorHandler
} = {}) {
  return new SelectionPublisher({
    repository,
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    syncWorker,
    restartHandler,
    fatalBotErrorHandler,
    config: {
      telegram: {
        botToken: 'token',
        adminId: 1,
        publishChannelId: -1001,
        sourceChatId: -1002,
        pollingLockFile
      },
      logging: { logLevel: 'silent' },
      publish: {
        dryRun: true,
        template: [
          { source: 'best', key: 'day', enabled: true, limit: 1, template: 'Best day' }
        ]
      },
      schedule: { timezone: 'UTC' },
      templates: {}
    }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a synchronous polling launch failure releases the acquired lock', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-bot-sync-launch-'));
  const lockPath = path.join(tempDir, 'polling.lock');
  const expected = new Error('launch failed synchronously');
  const publisher = createPublisher({ pollingLockFile: lockPath });
  publisher.bot = {
    telegram: { getMe: async () => ({ id: 1 }) },
    launch: () => { throw expected; }
  };

  await assert.rejects(() => publisher.launchBot(), expected);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
  await fs.rm(tempDir, { recursive: true, force: true });
});
