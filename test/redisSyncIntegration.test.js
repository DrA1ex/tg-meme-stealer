import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SyncWorker } from '../src/runtime/syncWorker.js';
import { createRedisRateLimitStore } from '../src/telegram/redisRateLimitStore.js';
import { TelegramScanner } from '../src/telegram/scanner.js';
import { TelegramThrottle } from '../src/telegram/throttle.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const REAL_REDIS_OPTIONS = {
  skip: !TEST_REDIS_URL,
  timeout: 15_000
};

test('real Redis serializes concurrent synchronization history reads across instances', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const intervalMs = 70;
  const prefix = uniquePrefix('sync-burst');
  const harnesses = await Promise.all(Array.from({ length: 5 }, (_, index) => track(createSyncHarness({
    prefix,
    group: 'shared-account',
    intervalMs,
    instance: index
  }))));

  const jobs = await Promise.all(harnesses.map((harness) => harness.worker.sync('schedule')));
  const results = await Promise.all(jobs.map((job) => job.promise));

  assert.ok(results.every((result) => result.authoritativeComplete === true));
  assert.ok(results.every((result) => result.pages === 1));

  const calls = harnesses
    .flatMap((harness) => harness.historyCalls)
    .sort((left, right) => left.at - right.at);
  assert.equal(calls.length, harnesses.length);
  assert.equal(new Set(calls.map((call) => call.instance)).size, harnesses.length);

  for (let index = 1; index < calls.length; index += 1) {
    const gap = calls[index].at - calls[index - 1].at;
    assert.ok(
      gap >= intervalMs - 15,
      `expected Redis to separate history calls by about ${intervalMs}ms, got ${gap}ms between ${calls[index - 1].instance} and ${calls[index].instance}`
    );
  }
});

test('real Redis propagates a shared FLOOD_WAIT to another synchronization worker', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const prefix = uniquePrefix('sync-flood');
  const controller = await track(createThrottleHarness({ prefix, group: 'shared-account', intervalMs: 0 }));
  const target = await track(createSyncHarness({ prefix, group: 'shared-account', intervalMs: 0, instance: 'target' }));

  await controller.throttle.noteFloodWait('history', 0.25);
  const startedAt = Date.now();
  const job = await target.worker.sync('schedule');
  const result = await job.promise;

  assert.equal(result.authoritativeComplete, true);
  assert.equal(target.historyCalls.length, 1);
  const elapsedMs = target.historyCalls[0].at - startedAt;
  assert.ok(elapsedMs >= 180, `expected shared FLOOD_WAIT to delay sync, got ${elapsedMs}ms`);
});

test('real Redis revalidates a queued synchronization reservation after a newer FLOOD_WAIT', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const intervalMs = 180;
  const prefix = uniquePrefix('sync-revalidate');
  const primer = await track(createThrottleHarness({ prefix, group: 'shared-account', intervalMs }));
  const flooder = await track(createThrottleHarness({ prefix, group: 'shared-account', intervalMs }));
  const target = await track(createSyncHarness({ prefix, group: 'shared-account', intervalMs, instance: 'target' }));

  await primer.throttle.wait('history');

  const startedAt = Date.now();
  const job = await target.worker.sync('schedule');
  const floodPromise = delay(30).then(() => flooder.throttle.noteFloodWait('history', 0.35));
  const [result] = await Promise.all([job.promise, floodPromise]);

  assert.equal(result.authoritativeComplete, true);
  assert.equal(target.historyCalls.length, 1);
  const elapsedMs = target.historyCalls[0].at - startedAt;
  assert.ok(
    elapsedMs >= 300,
    `expected the queued reservation to be invalidated and requeued after FLOOD_WAIT, got ${elapsedMs}ms`
  );
});

test('real Redis coordinates native reaction enrichment across scanner instances', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const reactionsIntervalMs = 100;
  const prefix = uniquePrefix('sync-reactions');
  const first = await track(createReactionHarness({ prefix, group: 'shared-account', reactionsIntervalMs, instance: 'first' }));
  const second = await track(createReactionHarness({ prefix, group: 'shared-account', reactionsIntervalMs, instance: 'second' }));

  const [firstHistory, secondHistory] = await Promise.all([
    first.scanner.getHistory({ limit: 1 }),
    second.scanner.getHistory({ limit: 1 })
  ]);

  assert.equal(firstHistory[0].nativeReactions[0].count, 1);
  assert.equal(secondHistory[0].nativeReactions[0].count, 1);

  const calls = [...first.reactionCalls, ...second.reactionCalls].sort((left, right) => left.at - right.at);
  assert.equal(calls.length, 2);
  const gap = calls[1].at - calls[0].at;
  assert.ok(gap >= reactionsIntervalMs - 15, `expected Redis to separate reaction enrichment calls, got ${gap}ms`);
});

test('real Redis enforces the synchronization queue-delay budget before Telegram is called', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const prefix = uniquePrefix('sync-budget');
  const controller = await track(createThrottleHarness({ prefix, group: 'shared-account', intervalMs: 0 }));
  const target = await track(createSyncHarness({
    prefix,
    group: 'shared-account',
    intervalMs: 0,
    instance: 'budget',
    maxQueueDelayMs: 80
  }));

  await controller.throttle.noteFloodWait('history', 0.3);
  const job = await target.worker.sync('schedule');
  const result = await job.promise;

  assert.equal(result.failed, true);
  assert.equal(target.historyCalls.length, 0);
  assert.equal(target.worker.canPublish(), false);
  assert.match(result.error, /queue delay|wait budget/i);
});

test('real Redis keeps synchronization for different MTProto account groups independent', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const intervalMs = 1500;
  const prefix = uniquePrefix('sync-groups');
  const first = await track(createSyncHarness({
    prefix,
    group: 'account-a',
    intervalMs,
    instance: 'account-a'
  }));
  const second = await track(createSyncHarness({
    prefix,
    group: 'account-b',
    intervalMs,
    instance: 'account-b'
  }));

  const firstJob = await first.worker.sync('schedule');
  await firstJob.promise;

  const secondStartedAt = Date.now();
  const secondJob = await second.worker.sync('schedule');
  await secondJob.promise;

  const elapsedMs = second.historyCalls[0].at - secondStartedAt;
  assert.ok(elapsedMs < 600, `expected a different MTProto group to avoid the existing 1500ms reservation, got ${elapsedMs}ms`);
});

test('required real Redis failure prevents Telegram reads and pauses synchronization', REAL_REDIS_OPTIONS, async (t) => {
  const track = trackHarnesses(t);
  const harness = await track(createSyncHarness({
    prefix: uniquePrefix('sync-required'),
    group: 'shared-account',
    intervalMs: 0,
    instance: 'required',
    maxRetries: 1
  }));

  await harness.store.close();
  const job = await harness.worker.sync('schedule');
  const result = await job.promise;

  assert.equal(result.failed, true);
  assert.equal(result.attempts, 2);
  assert.equal(harness.historyCalls.length, 0);
  assert.equal(harness.worker.canPublish(), false);
  assert.match(harness.worker.getPublicationPauseReason(), /Required Redis rate limiter is unavailable/);
});

async function createSyncHarness({ prefix, group, intervalMs, instance, maxRetries = 0, maxQueueDelayMs = 5_000 }) {
  const config = redisSyncConfig({
    prefix,
    group,
    historyIntervalMs: intervalMs,
    reactionsIntervalMs: 0,
    maxRetries,
    maxQueueDelayMs
  });
  const logger = createTestLogger();
  const store = await createRedisRateLimitStore(config, { logger });
  const throttle = new TelegramThrottle(config, null, Date.now, store);
  const historyCalls = [];
  const client = {
    async getHistory() {
      historyCalls.push({ at: Date.now(), instance });
      return historyPage([]);
    }
  };
  const scanner = new TelegramScanner({
    client,
    repository: createRepository(),
    config,
    throttle
  });
  const worker = new SyncWorker({
    scanner,
    config,
    sleepFn: async () => {}
  });
  return { config, store, throttle, scanner, worker, historyCalls };
}

async function createReactionHarness({ prefix, group, reactionsIntervalMs, instance }) {
  const config = redisSyncConfig({
    prefix,
    group,
    historyIntervalMs: 0,
    reactionsIntervalMs,
    maxRetries: 0
  });
  config.parsing = {
    likes: [{ path: 'nativeReactions', transform: 'reactionCount' }]
  };
  const logger = createTestLogger();
  const store = await createRedisRateLimitStore(config, { logger });
  const throttle = new TelegramThrottle(config, null, Date.now, store);
  const reactionCalls = [];
  const client = {
    async getHistory() {
      return historyPage([{
        id: instance === 'first' ? 1 : 2,
        date: new Date(),
        text: `By ${instance}\nPost`,
        reactions: { results: [] }
      }]);
    },
    async getMessageReactions(messages) {
      reactionCalls.push({ at: Date.now(), instance, count: messages.length });
      return [{ reactions: [{ reaction: '👍', count: 1 }] }];
    }
  };
  const scanner = new TelegramScanner({
    client,
    repository: createRepository(),
    config,
    throttle
  });
  return { config, store, throttle, scanner, reactionCalls };
}

async function createThrottleHarness({ prefix, group, intervalMs }) {
  const config = redisSyncConfig({
    prefix,
    group,
    historyIntervalMs: intervalMs,
    reactionsIntervalMs: intervalMs,
    maxRetries: 0
  });
  const store = await createRedisRateLimitStore(config, { logger: createTestLogger() });
  const throttle = new TelegramThrottle(config, null, Date.now, store);
  return { config, store, throttle };
}

function redisSyncConfig({ prefix, group, historyIntervalMs, reactionsIntervalMs, maxRetries, maxQueueDelayMs = 5_000 }) {
  return {
    logging: { logLevel: 'silent' },
    telegram: { sourceChatId: -1001234567890 },
    parsing: {},
    sync: {
      initialScanDays: 1,
      refreshRecentDays: 1,
      retentionDays: 30,
      pageSize: 10,
      maxPagesPerRun: 5,
      maxMissingRatio: 0.3,
      maxRetries,
      retryBaseMs: 1,
      retryMaxMs: 1,
      throttle: {
        enabled: true,
        historyMinMs: historyIntervalMs,
        historyMaxMs: historyIntervalMs,
        reactionsMinMs: reactionsIntervalMs,
        reactionsMaxMs: reactionsIntervalMs,
        mediaMinMs: 0,
        mediaMaxMs: 0,
        retryBufferMs: 0
      }
    },
    rateLimit: {
      mtprotoGroup: group,
      maxQueueDelayMs,
      longWaitWarnMs: 5_000,
      telegramOperationTimeoutMs: 2_000,
      redis: {
        enabled: true,
        required: true,
        mode: 'standalone',
        url: TEST_REDIS_URL,
        keyPrefix: prefix,
        connectTimeoutMs: 1_000,
        reconnectIntervalMs: 100,
        operationTimeoutMs: 1_000,
        circuitBreakMs: 100,
        fallbackMultiplier: 3,
        warningIntervalMs: 1_000,
        keyTtlMs: 5_000,
        penaltyTtlMs: 5_000,
        penaltyQuietPeriodMs: 100,
        penaltyDecayIntervalMs: 50
      }
    }
  };
}

function createRepository() {
  return {
    async all() { return [{ count: 0 }]; },
    async listPostIdsSince() { return []; },
    async upsertPost() {},
    async deletePost() {}
  };
}

function historyPage(messages, next = null) {
  const page = [...messages];
  page.next = next;
  return page;
}

function uniquePrefix(label) {
  return `tg-memes:test:${label}:${process.pid}:${randomUUID()}`;
}

function trackHarnesses(t) {
  const harnesses = [];
  t.after(async () => closeHarnesses(harnesses));
  return async (harnessPromise) => {
    const harness = await harnessPromise;
    harnesses.push(harness);
    return harness;
  };
}

async function closeHarnesses(harnesses) {
  await Promise.allSettled(harnesses.map(async (harness) => {
    harness.throttle?.close?.();
    await harness.store?.close?.();
  }));
}

function createTestLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
