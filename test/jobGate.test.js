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
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
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
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
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
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});

test('JobGate clears state after failed running job and starts queued job', async () => {
  const events = [];
  const gate = new JobGate();

  const first = gate.run('first', async () => {
    events.push('first');
    throw new Error('failed first');
  });
  const second = gate.run('second', async () => {
    events.push('second');
    return 'second';
  });

  assert.equal(first.status, 'running');
  assert.equal(second.status, 'scheduled');
  assert.deepEqual(await first.promise, { failed: true, error: 'failed first' });
  assert.equal(await second.promise, 'second');
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});

test('JobGate runs nested same-key calls inline under one lock', async () => {
  const gate = new JobGate();
  const events = [];
  let nested;
  let deepest;

  const parent = gate.run('publish-worker', async () => {
    events.push('parent:start');
    assert.equal(gate.runningKey, 'publish-worker');
    assert.equal(gate.keyCounts.get('publish-worker'), 1);

    nested = gate.run('publish-worker', async () => {
      events.push('nested:start');
      assert.equal(gate.runningKey, 'publish-worker');
      assert.equal(gate.keyCounts.get('publish-worker'), 1);

      deepest = gate.run('publish-worker', async () => {
        events.push('deepest');
        assert.equal(gate.runningKey, 'publish-worker');
        assert.equal(gate.keyCounts.get('publish-worker'), 1);
        return 'deepest';
      });

      assert.equal(deepest.status, 'running');
      assert.equal(await deepest.promise, 'deepest');
      events.push('nested:end');
      return 'nested';
    });

    assert.equal(nested.status, 'running');
    assert.deepEqual(events, ['parent:start', 'nested:start', 'deepest']);
    assert.equal(await nested.promise, 'nested');
    events.push('parent:end');
    return 'parent';
  });

  assert.equal(parent.status, 'running');
  assert.equal(await parent.promise, 'parent');
  assert.deepEqual(events, ['parent:start', 'nested:start', 'deepest', 'nested:end', 'parent:end']);
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});

test('JobGate runs nested same-key runIfIdle calls inline under one lock', async () => {
  const gate = new JobGate();
  let nested;

  const parent = gate.run('retention', async () => {
    nested = gate.runIfIdle('retention', async () => {
      assert.equal(gate.runningKey, 'retention');
      assert.equal(gate.keyCounts.get('retention'), 1);
      return 'nested';
    });
    return nested.promise;
  });

  const result = await parent.promise;

  assert.equal(nested.status, 'running');
  assert.equal(result, 'nested');
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});

test('JobGate fails nested different-key run calls to avoid self-deadlock', async () => {
  const gate = new JobGate();

  const parent = gate.run('parent', async () => {
    const nested = gate.run('child', async () => {
      throw new Error('nested child should not run');
    });
    return nested.promise;
  });

  const result = await parent.promise;

  assert.deepEqual(result, { failed: true, error: 'Detected nested dead-lock, forbidden' });
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});

test('JobGate fails nested different-key runIfIdle calls to avoid self-deadlock', async () => {
  const gate = new JobGate();

  const parent = gate.run('parent', async () => {
    const nested = gate.runIfIdle('child', async () => {
      throw new Error('nested child should not run');
    });
    return nested.promise;
  });

  const result = await parent.promise;

  assert.deepEqual(result, { failed: true, error: 'Detected nested dead-lock, forbidden' });
  assert.equal(gate.runningKey, null);
  assert.equal(gate.queue.length, 0);
  assert.equal(gate.keyCounts.size, 0);
});
