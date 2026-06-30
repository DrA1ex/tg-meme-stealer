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
    config: { logging: { level: 'silent' } }
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
    config: { logging: { level: 'silent' } }
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
