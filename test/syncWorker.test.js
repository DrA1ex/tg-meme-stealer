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
    config: { logging: { level: 'silent' } }
  });

  const first = worker.sync('schedule');
  await Promise.resolve();
  const second = await worker.sync('schedule');

  assert.deepEqual(second, {
    skipped: true,
    reason: 'sync_worker_busy',
    operation: 'sync',
    source: 'schedule'
  });
  assert.equal(runs, 1);

  resolveSync();
  assert.deepEqual(await first, { seen: 10 });
});

test('SyncWorker skips backfill while sync is running', async () => {
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
    config: { logging: { level: 'silent' } }
  });

  const first = worker.sync('schedule');
  await Promise.resolve();
  const second = await worker.backfill(90, 'admin');

  assert.equal(second.skipped, true);
  assert.equal(second.operation, 'backfill');

  resolveSync();
  await first;
});
