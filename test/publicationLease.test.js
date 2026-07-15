import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicationLeaseGuard } from '../src/telegram/publicationLease.js';

test('PublicationLeaseGuard does not overlap lease renewals', async () => {
  let resolveRenewal;
  let calls = 0;
  const guard = new PublicationLeaseGuard({
    repository: {
      renewPublicationLease: async () => {
        calls += 1;
        await new Promise((resolve) => { resolveRenewal = resolve; });
      }
    },
    publicationId: 1,
    ownerId: 'worker',
    leaseMs: 30_000
  });

  const first = guard.heartbeat();
  const second = guard.heartbeat();
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveRenewal();
  await Promise.all([first, second]);
  await guard.stop();
});

test('PublicationLeaseGuard aborts side effects and throws after lease loss', async () => {
  const error = Object.assign(new Error('claim was stolen'), { code: 'PUBLICATION_LEASE_LOST' });
  const guard = new PublicationLeaseGuard({
    repository: { renewPublicationLease: async () => { throw error; } },
    publicationId: 2,
    ownerId: 'worker',
    leaseMs: 30_000
  });

  await guard.heartbeat();
  assert.equal(guard.signal.aborted, true);
  assert.throws(() => guard.assertActive(), (caught) => caught === error);
  await guard.stop();
});

test('PublicationLeaseGuard.stop waits for an in-flight heartbeat', async () => {
  let resolveRenewal;
  let finished = false;
  const guard = new PublicationLeaseGuard({
    repository: {
      renewPublicationLease: () => new Promise((resolve) => {
        resolveRenewal = () => { finished = true; resolve(); };
      })
    },
    publicationId: 3,
    ownerId: 'worker',
    leaseMs: 30_000
  });

  guard.heartbeat();
  await Promise.resolve();
  const stop = guard.stop();
  let stopped = false;
  stop.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  resolveRenewal();
  await stop;
  assert.equal(finished, true);
});
