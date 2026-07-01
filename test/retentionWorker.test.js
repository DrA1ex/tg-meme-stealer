import assert from 'node:assert/strict';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { JobGate } from '../src/runtime/jobGate.js';
import { RetentionWorker } from '../src/runtime/retentionWorker.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('RetentionWorker queues cleanup through shared JobGate', async () => {
  const events = [];
  let releaseSync;
  const syncDone = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const jobGate = new JobGate();
  const running = jobGate.run('sync', async () => {
    events.push('sync:start');
    await syncDone;
    events.push('sync:end');
  });
  const worker = new RetentionWorker({
    jobGate,
    scanner: {
      cleanupOldPosts: async () => {
        events.push('retention');
        return 2;
      }
    }
  });

  const retention = worker.run('schedule');
  await Promise.resolve();

  assert.equal(running.status, 'running');
  assert.equal(retention.status, 'scheduled');
  assert.deepEqual(events, ['sync:start']);

  releaseSync();
  const result = await retention.promise;

  assert.deepEqual(events, ['sync:start', 'sync:end', 'retention']);
  assert.deepEqual(result, { source: 'schedule', prunedOld: 2 });
});
