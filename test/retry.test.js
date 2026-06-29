import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBotApiRetryAfterSeconds,
  getFloodWaitSeconds,
  withBotApiRetry
} from '../src/telegram/retry.js';

test('getFloodWaitSeconds reads mtcute RpcError seconds', () => {
  assert.equal(getFloodWaitSeconds({ code: 420, text: 'FLOOD_WAIT_%d', seconds: 20 }), 20);
});

test('getFloodWaitSeconds reads numeric suffix from message', () => {
  assert.equal(getFloodWaitSeconds({ message: 'FLOOD_WAIT_42' }), 42);
});

test('getBotApiRetryAfterSeconds reads Telegraf retry_after', () => {
  assert.equal(getBotApiRetryAfterSeconds({
    response: {
      error_code: 429,
      description: 'Too Many Requests: retry after 24',
      parameters: { retry_after: 24 }
    }
  }), 24);
});

test('getBotApiRetryAfterSeconds reads retry_after from description', () => {
  assert.equal(getBotApiRetryAfterSeconds({ message: '429: Too Many Requests: retry after 12' }), 12);
});

test('withBotApiRetry waits and retries 429 responses', async () => {
  const waits = [];
  let attempts = 0;

  const result = await withBotApiRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          response: {
            error_code: 429,
            parameters: { retry_after: 2 }
          }
        };
      }
      return 'ok';
    },
    {
      label: 'sendPhoto',
      sleepFn: async (ms) => waits.push(ms)
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [3000]);
});
