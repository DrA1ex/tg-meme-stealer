import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLogger } from '../src/core/logger.js';
import {
  getBotApiRetryAfterSeconds,
  getFloodWaitSeconds,
  withBotApiRetry,
  withTelegramRetry
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
  const warnings = [];
  configureLogger({ logging: { logLevel: 'WARN' } }, {
    log: () => {},
    warn: (line) => warnings.push(line),
    error: () => {}
  });
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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[WARN\] \[retry\] sendPhoto hit Too Many Requests/);
  assert.match(warnings[0], /retryAfter=2/);
  assert.match(warnings[0], /retryInSeconds=3/);
});

test('withTelegramRetry delegates FLOOD_WAIT cooldown to the adaptive limiter', async () => {
  const calls = [];
  let attempts = 0;
  const result = await withTelegramRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw { code: 420, seconds: 5 };
      return 'ok';
    },
    {
      kind: 'reactions',
      sleepFn: async () => assert.fail('direct sleep must not run when limiter owns the cooldown'),
      rateLimiter: {
        wait: async (kind) => calls.push(['wait', kind]),
        noteFloodWait: (kind, seconds) => { calls.push(['flood', kind, seconds]); return true; },
        noteSuccess: (kind) => calls.push(['success', kind])
      }
    }
  );

  assert.equal(result, 'ok');
  assert.deepEqual(calls, [
    ['wait', 'reactions'],
    ['flood', 'reactions', 5],
    ['wait', 'reactions'],
    ['success', 'reactions']
  ]);
});
