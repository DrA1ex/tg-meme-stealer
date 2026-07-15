import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupInitializedResources, settleBeforeDeadline } from '../src/runtime/app.js';

test('settleBeforeDeadline reports completed work', async () => {
  assert.equal(await settleBeforeDeadline(Promise.resolve('done'), Date.now() + 100), true);
});

test('settleBeforeDeadline bounds work that never settles', async () => {
  const startedAt = Date.now();
  assert.equal(await settleBeforeDeadline(new Promise(() => {}), startedAt + 5), false);
  assert.ok(Date.now() - startedAt < 100);
});


test('cleanupInitializedResources closes every initialized resource even when one cleanup fails', async () => {
  const calls = [];
  const failure = new Error('store close failed');
  const errors = await cleanupInitializedResources({
    botRateLimiter: { close: async () => calls.push('bot-rate-limiter') },
    telegramThrottle: { close: async () => calls.push('telegram-throttle') },
    sharedRateLimitStore: {
      close: async () => {
        calls.push('shared-store');
        throw failure;
      }
    },
    userClient: { destroy: async () => calls.push('user-client') },
    repository: { close: async () => calls.push('repository') }
  });

  assert.deepEqual(calls, [
    'bot-rate-limiter',
    'telegram-throttle',
    'shared-store',
    'user-client',
    'repository'
  ]);
  assert.deepEqual(errors, [failure]);
});

test('cleanupInitializedResources ignores resources that were not created yet', async () => {
  assert.deepEqual(await cleanupInitializedResources(), []);
});
