import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/runtime/syncWorker.js';

test('SyncWorker skips overlapping sync jobs', async () => {
  let resolveSync;
  let runs = 0;
  const worker = new SyncWorker({
    scanner: {
      sync: async () => {
        runs += 1;
        await new Promise((resolve) => {
          resolveSync = resolve;
        });
        return { seen: 10 };
      }
    },
    config: { logging: { logLevel: 'silent' } }
  });

  const first = await worker.sync('schedule');
  await Promise.resolve();
  const second = await worker.sync('schedule');

  assert.equal(first.status, 'running');
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'duplicate_job');
  assert.equal(runs, 1);

  resolveSync();
  assert.deepEqual(await first.promise, { seen: 10 });
});

test('SyncWorker returns busy for admin backfill while sync is running', async () => {
  let resolveSync;
  const worker = new SyncWorker({
    scanner: {
      sync: async () => {
        await new Promise((resolve) => {
          resolveSync = resolve;
        });
        return { seen: 10 };
      },
      backfill: async () => {
        throw new Error('backfill should be skipped');
      }
    },
    config: { logging: { logLevel: 'silent' } }
  });

  const first = await worker.sync('schedule');
  await Promise.resolve();
  const second = await worker.backfill(90, 'admin');

  assert.equal(second.status, 'busy');
  assert.equal(second.reason, 'busy');

  resolveSync();
  await first.promise;
});

test('SyncWorker queues scheduled backfill after running sync', async () => {
  let resolveSync;
  const events = [];
  const worker = new SyncWorker({
    scanner: {
      sync: async () => {
        events.push('sync:start');
        await new Promise((resolve) => {
          resolveSync = resolve;
        });
        events.push('sync:end');
        return { seen: 10 };
      },
      backfill: async () => {
        events.push('backfill');
        return { seen: 20 };
      }
    },
    config: { logging: { logLevel: 'silent' } }
  });

  const first = await worker.sync('schedule');
  await Promise.resolve();
  const second = await worker.backfill(90, 'schedule');

  assert.equal(first.status, 'running');
  assert.equal(second.status, 'scheduled');
  assert.deepEqual(events, ['sync:start']);

  resolveSync();
  assert.deepEqual(await first.promise, { seen: 10 });
  assert.deepEqual(await second.promise, { seen: 20 });
  assert.deepEqual(events, ['sync:start', 'sync:end', 'backfill']);
});

test('SyncWorker retries failed synchronization and clears publication pause after success', async () => {
  let attempts = 0;
  const delays = [];
  const worker = new SyncWorker({
    scanner: {
      sync: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`failure ${attempts}`);
        return { seen: 20 };
      }
    },
    config: { sync: { maxRetries: 3, retryBaseMs: 10, retryMaxMs: 100 }, logging: { logLevel: 'silent' } },
    sleepFn: async (delay) => delays.push(delay)
  });
  worker.publicationPaused = true;
  worker.pauseReason = 'old failure';

  const job = await worker.sync('schedule');
  const result = await job.promise;

  assert.deepEqual(result, { seen: 20 });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(worker.canPublish(), true);
  assert.equal(worker.getPublicationPauseReason(), '');
});

test('SyncWorker pauses publication and tells the admin how to recover after retries are exhausted', async () => {
  const notifications = [];
  let attempts = 0;
  const worker = new SyncWorker({
    scanner: { sync: async () => { attempts += 1; throw new Error('Telegram unavailable'); } },
    config: { sync: { maxRetries: 2, retryBaseMs: 1, retryMaxMs: 1 }, logging: { logLevel: 'silent' } },
    notifyAdmin: async (message) => notifications.push(message),
    sleepFn: async () => {}
  });

  const job = await worker.sync('schedule');
  const result = await job.promise;

  assert.equal(result.failed, true);
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.equal(worker.canPublish(), false);
  assert.match(worker.getPublicationPauseReason(), /Synchronization failed after 3 attempts/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Automatic publication has been paused/);
  assert.match(notifications[0], /Run \/sync to retry manually/);
  assert.match(notifications[0], /\/sync --force/);
  assert.match(notifications[0], /\/publish <selection>/);
});

test('SyncWorker forwards force reconciliation and reports a blocked safety check without pausing publication', async () => {
  const calls = [];
  const notifications = [];
  const worker = new SyncWorker({
    scanner: {
      sync: async (options) => {
        calls.push(options);
        return {
          seen: 7,
          reconciliationBlocked: true,
          reconciliationReason: 'missing_ratio_exceeded',
          expectedRecent: 10,
          missingRecent: 4,
          missingRatio: 0.4
        };
      }
    },
    config: { sync: { maxRetries: 0, maxMissingRatio: 0.3 }, logging: { logLevel: 'silent' } },
    notifyAdmin: async (message) => notifications.push(message)
  });

  const job = await worker.sync('admin', { force: true });
  const result = await job.promise;

  assert.equal(result.reconciliationBlocked, true);
  assert.deepEqual(calls, [{ force: true }]);
  assert.equal(worker.canPublish(), true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /No local posts were deleted/);
  assert.match(notifications[0], /40\.0%/);
  assert.match(notifications[0], /\/sync --force/);
});
