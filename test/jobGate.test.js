import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLogger } from '../src/core/logger.js';
import { JobGate } from '../src/runtime/jobGate.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('JobGate queues different keys and skips duplicate keys', async () => {
  let releaseFirst;
  const events = [];
  const gate = new JobGate();

  const first = gate.run('sync', async () => {
    events.push('sync:start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push('sync:end');
    return 'sync';
  });
  const duplicate = gate.run('sync', async () => {
    throw new Error('duplicate should not run');
  });
  const second = gate.run('publish', async () => {
    events.push('publish');
    return 'publish';
  });

  assert.equal(first.status, 'running');
  assert.equal(duplicate.status, 'skipped');
  assert.equal(duplicate.reason, 'duplicate_job');
  assert.equal(second.status, 'scheduled');
  assert.deepEqual(events, []);

  await Promise.resolve();
  assert.deepEqual(events, ['sync:start']);

  releaseFirst();
  assert.equal(await first.promise, 'sync');
  assert.equal(await second.promise, 'publish');
  assert.deepEqual(events, ['sync:start', 'sync:end', 'publish']);
});

test('JobGate runIfIdle returns busy when any job is running', async () => {
  let releaseFirst;
  const gate = new JobGate();

  const first = gate.run('sync', async () => {
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  });
  const second = gate.runIfIdle('backfill', async () => {
    throw new Error('busy job should not run');
  });

  assert.equal(second.status, 'busy');
  assert.equal(second.reason, 'busy');

  await Promise.resolve();
  releaseFirst();
  await first.promise;
});

test('JobGate can queue one follow-up for a running duplicate key', async () => {
  let releaseFirst;
  const events = [];
  const gate = new JobGate();

  const first = gate.run('publish-worker', async () => {
    events.push('first:start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push('first:end');
    return 'first';
  });
  const followUp = gate.run('publish-worker', async () => {
    events.push('follow-up');
    return 'follow-up';
  }, { queueIfRunning: true });
  const duplicateFollowUp = gate.run('publish-worker', async () => {
    throw new Error('second follow-up should not run');
  }, { queueIfRunning: true });

  assert.equal(first.status, 'running');
  assert.equal(followUp.status, 'scheduled');
  assert.equal(duplicateFollowUp.status, 'skipped');
  assert.equal(duplicateFollowUp.reason, 'duplicate_job');

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);

  releaseFirst();
  assert.equal(await first.promise, 'first');
  assert.equal(await followUp.promise, 'follow-up');
  assert.deepEqual(events, ['first:start', 'first:end', 'follow-up']);
});
