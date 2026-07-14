import assert from 'node:assert/strict';
import test from 'node:test';
import { BotApiRateLimiter } from '../src/telegram/botRateLimiter.js';

test('BotApiRateLimiter enforces per-chat and global send intervals', async () => {
  const waits = [];
  let now = 1000;
  const limiter = new BotApiRateLimiter(
    { publish: { throttle: { perChatMinMs: 1100, globalMinMs: 40 } } },
    async (ms) => { waits.push(ms); now += ms; },
    () => now
  );

  assert.equal(await limiter.wait(-100), 0);
  assert.equal(await limiter.wait(-200), 40);
  assert.equal(await limiter.wait(-100), 1060);
  assert.deepEqual(waits, [40, 1060]);
});

test('BotApiRateLimiter applies Telegram retry_after to all sends', async () => {
  let now = 1000;
  const limiter = new BotApiRateLimiter(
    { publish: { throttle: { perChatMinMs: 1100, globalMinMs: 40, retryBufferMs: 1000 } } },
    async (ms) => { now += ms; },
    () => now
  );

  await limiter.wait(-100);
  await limiter.noteRateLimit(2, -100);
  assert.equal(await limiter.wait(-200), 3000);
});

test('BotApiRateLimiter scopes token quotas separately and shares destination slots', async () => {
  const requests = [];
  const sharedStore = {
    reserve: async (request) => { requests.push(request); return { delayMs: 25 }; },
    block: async () => true
  };
  let now = 1000;
  const limiter = new BotApiRateLimiter(
    {
      telegram: { botToken: '123456:secret' },
      publish: { throttle: { perChatMinMs: 1100, globalMinMs: 40, sharedDestinationMinMs: 350 } }
    },
    async (ms) => { now += ms; },
    () => now,
    sharedStore
  );

  assert.equal(await limiter.wait(-100500), 25);
  assert.deepEqual(requests[0].slots.map((slot) => slot.key), [
    'bot-api:123456',
    'bot-api:123456:chat:-100500',
    'bot-api:destination:-100500'
  ]);
});
