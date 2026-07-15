import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTelegramError, runWithTelegramFailurePolicy } from '../src/telegram/errorPolicy.js';

test('classifyTelegramError distinguishes definitive, network, and indeterminate failures', () => {
  assert.equal(classifyTelegramError({ response: { error_code: 400, description: 'Bad Request' } }), 'permanent');
  assert.equal(classifyTelegramError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })), 'network');
  assert.equal(classifyTelegramError(Object.assign(new Error('timeout'), { indeterminate: true })), 'indeterminate');
});

test('runWithTelegramFailurePolicy retries an unknown error three times before exhausting it', async () => {
  let attempts = 0;
  const delays = [];
  const error = new Error('unclassified failure');

  await assert.rejects(
    runWithTelegramFailurePolicy(async () => {
      attempts += 1;
      throw error;
    }, {
      maxUnknownRetries: 3,
      sleepFn: async (delay) => delays.push(delay),
      baseDelayMs: 10,
      maxDelayMs: 100
    }),
    (caught) => caught === error && caught.telegramFailureClass === 'unknown_exhausted' && caught.retryCount === 3
  );

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40]);
});

test('runWithTelegramFailurePolicy keeps retrying network errors until Telegram recovers', async () => {
  let attempts = 0;
  const delays = [];
  const result = await runWithTelegramFailurePolicy(async () => {
    attempts += 1;
    if (attempts <= 5) throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' });
    return 'sent';
  }, {
    maxUnknownRetries: 0,
    sleepFn: async (delay) => delays.push(delay),
    baseDelayMs: 1,
    maxDelayMs: 4
  });

  assert.equal(result, 'sent');
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [1, 2, 4, 4, 4]);
});

test('runWithTelegramFailurePolicy never retries a definitive Telegram response', async () => {
  let attempts = 0;
  const error = { response: { error_code: 403, description: 'Forbidden' } };
  await assert.rejects(runWithTelegramFailurePolicy(async () => {
    attempts += 1;
    throw error;
  }, { sleepFn: async () => assert.fail('must not sleep') }), (caught) => caught.telegramFailureClass === 'permanent');
  assert.equal(attempts, 1);
});
