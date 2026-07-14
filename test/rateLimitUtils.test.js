import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertQueueDeadline,
  assertQueueDelay,
  RateLimitQueueDelayError,
  sleepWithSignal
} from '../src/telegram/rateLimitUtils.js';

test('assertQueueDeadline limits cumulative waits, not only each sleep', () => {
  const logger = { warn: () => {} };
  assert.throws(
    () => assertQueueDeadline(30, 100, 80, { maxQueueDelayMs: 100 }, logger, { scope: 'test' }),
    RateLimitQueueDelayError
  );
});

test('assertQueueDelay rejects an excessively stale queue slot', () => {
  const logger = { warn: () => {} };
  assert.throws(
    () => assertQueueDelay(5001, { maxQueueDelayMs: 5000, longWaitWarnMs: 1000 }, logger, { scope: 'test' }),
    RateLimitQueueDelayError
  );
  assert.equal(assertQueueDelay(2000, { maxQueueDelayMs: 5000, longWaitWarnMs: 1000 }, logger), true);
});

test('sleepWithSignal cancels a pending rate-limit wait during shutdown', async () => {
  const controller = new AbortController();
  const waiting = sleepWithSignal(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { code: 'RATE_LIMIT_CANCELLED' });
});
