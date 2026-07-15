import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { configureLogger } from '../src/core/logger.js';
import {
  getBotApiRetryAfterSeconds,
  getFloodWaitSeconds,
  TelegramOperationCancelledError,
  TelegramOperationTimeoutError,
  withBotApiRetry,
  withTelegramRetry
} from '../src/telegram/retry.js';

test('withBotApiRetry stops a hung Telegram request with an indeterminate timeout', async () => {
  await assert.rejects(
    withBotApiRetry(() => new Promise(() => {}), {
      label: 'sendPhoto',
      operationTimeoutMs: 5
    }),
    (error) => error instanceof TelegramOperationTimeoutError
      && error.code === 'TELEGRAM_OPERATION_TIMEOUT'
      && error.indeterminate === true
  );
});

test('withBotApiRetry does not start an operation after shutdown was requested', async () => {
  const controller = new AbortController();
  controller.abort(new Error('shutdown'));
  let called = false;

  await assert.rejects(
    withBotApiRetry(() => {
      called = true;
    }, { label: 'sendPhoto', signal: controller.signal }),
    (error) => error instanceof TelegramOperationCancelledError
      && error.code === 'TELEGRAM_OPERATION_CANCELLED'
      && error.indeterminate === false
  );
  assert.equal(called, false);
});

test('withBotApiRetry marks an aborted in-flight operation as indeterminate', async () => {
  const controller = new AbortController();
  let operationStarted;
  const started = new Promise((resolve) => {
    operationStarted = resolve;
  });
  const request = withBotApiRetry(() => {
    operationStarted();
    return new Promise(() => {});
  }, { label: 'sendPhoto', signal: controller.signal });

  await started;
  controller.abort(new Error('shutdown'));

  await assert.rejects(
    request,
    (error) => error instanceof TelegramOperationCancelledError
      && error.code === 'TELEGRAM_OPERATION_CANCELLED'
      && error.indeterminate === true
  );
});

test('Telegram operation timeout keeps an isolated process alive until it settles', () => {
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { withBotApiRetry } from './src/telegram/retry.js';
     try {
       await withBotApiRetry(() => new Promise(() => {}), { operationTimeoutMs: 5 });
       process.exitCode = 1;
     } catch (error) {
       if (error.code !== 'TELEGRAM_OPERATION_TIMEOUT') throw error;
     }`
  ], { cwd: process.cwd(), stdio: 'pipe', timeout: 2000 });
});

test('getFloodWaitSeconds reads mtcute RpcError seconds', () => {
  assert.equal(getFloodWaitSeconds({ code: 420, text: 'FLOOD_WAIT_%d', seconds: 20 }), 20);
});

test('getFloodWaitSeconds reads numeric suffix from message', () => {
  assert.equal(getFloodWaitSeconds({ message: 'FLOOD_WAIT_42' }), 42);
  assert.equal(getFloodWaitSeconds({ message: 'FLOOD_PREMIUM_WAIT_17' }), 17);
});

test('withTelegramRetry preserves a successful Telegram result when success accounting fails', async () => {
  const result = await withTelegramRetry(
    async () => 'sent',
    {
      rateLimiter: {
        wait: async () => {},
        noteSuccess: async () => { throw new Error('redis accounting failed'); }
      }
    }
  );
  assert.equal(result, 'sent');
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
  let beforeOperationCalls = 0;

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
      onBeforeOperation: async () => {
        beforeOperationCalls += 1;
      },
      sleepFn: async (ms) => waits.push(ms)
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(beforeOperationCalls, 2);
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

test('withTelegramRetry classifies read timeouts as determinate when requested', async () => {
  await assert.rejects(
    withTelegramRetry(() => new Promise(() => {}), {
      label: 'getHistory',
      operationTimeoutMs: 5,
      indeterminateOnTimeout: false
    }),
    (error) => error instanceof TelegramOperationTimeoutError
      && error.code === 'TELEGRAM_OPERATION_TIMEOUT'
      && error.indeterminate === false
  );
});

test('withTelegramRetry treats cancellation of an in-flight read as determinate', async () => {
  const controller = new AbortController();
  let operationStarted;
  const started = new Promise((resolve) => { operationStarted = resolve; });
  const request = withTelegramRetry(() => {
    operationStarted();
    return new Promise(() => {});
  }, {
    label: 'getHistory',
    signal: controller.signal,
    indeterminateOnAbort: false
  });

  await started;
  controller.abort(new Error('shutdown'));

  await assert.rejects(
    request,
    (error) => error instanceof TelegramOperationCancelledError
      && error.code === 'TELEGRAM_OPERATION_CANCELLED'
      && error.indeterminate === false
  );
});
