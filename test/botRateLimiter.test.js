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
    reserve: async (request) => {
      requests.push(request);
      return { status: 'ok', delayMs: 25, scheduledAt: 1025 };
    },
    validate: async () => ({ status: 'ok', invalidated: false, delayMs: 0 }),
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

test('BotApiRateLimiter requeues a reservation invalidated by a newer cooldown', async () => {
  const waits = [];
  let now = 1000;
  let reserves = 0;
  let validations = 0;
  const sharedStore = {
    reserve: async () => {
      reserves += 1;
      return reserves === 1
        ? { status: 'ok', delayMs: 10, scheduledAt: 1010 }
        : { status: 'ok', delayMs: 20, scheduledAt: 1030 };
    },
    validate: async () => {
      validations += 1;
      return validations === 1
        ? { status: 'ok', invalidated: true, delayMs: 50, blockedUntil: 1060 }
        : { status: 'ok', invalidated: false, delayMs: 0, blockedUntil: 0 };
    }
  };
  const limiter = new BotApiRateLimiter(
    {
      telegram: { botToken: '123456:secret' },
      publish: { throttle: { perChatMinMs: 0, globalMinMs: 0, sharedDestinationMinMs: 0 } }
    },
    async (ms) => { waits.push(ms); now += ms; },
    () => now,
    sharedStore
  );

  await limiter.wait(-100);
  assert.equal(reserves, 2);
  assert.equal(validations, 2);
  assert.deepEqual(waits, [10, 20]);
});

test('BotApiRateLimiter does not propagate one bot retry_after to other bots by default', async () => {
  const blocks = [];
  const sharedStore = {
    block: async (request) => { blocks.push(request); return 'ok'; }
  };
  const limiter = new BotApiRateLimiter({
    telegram: { botToken: '123456:secret' },
    rateLimit: { redis: { enabled: true } },
    publish: { throttle: { sharedDestinationMinMs: 350, shareRetryAfterAcrossBots: false } }
  }, async () => {}, () => 1000, sharedStore);

  await limiter.noteRateLimit(2, -100500);
  assert.deepEqual(blocks[0].keys, [
    'bot-api:123456',
    'bot-api:123456:chat:-100500'
  ]);
});

test('BotApiRateLimiter slows token and chat quotas while configured Redis is unavailable', async () => {
  const waits = [];
  let now = 1000;
  const sharedStore = {
    reserve: async () => ({ status: 'unavailable', backend: 'redis' })
  };
  const limiter = new BotApiRateLimiter({
    telegram: { botToken: '123456:secret' },
    rateLimit: { redis: { enabled: true, fallbackMultiplier: 3 } },
    publish: { throttle: { globalMinMs: 40, perChatMinMs: 1000, sharedDestinationMinMs: 0 } }
  }, async (ms) => { waits.push(ms); now += ms; }, () => now, sharedStore);

  assert.equal(await limiter.wait(-100), 0);
  assert.equal(await limiter.wait(-100), 3000);
  assert.deepEqual(waits, [3000]);
});

test('BotApiRateLimiter refuses local fallback when shared Redis is required', async () => {
  const limiter = new BotApiRateLimiter(
    {
      telegram: { botToken: '123456:token' },
      publish: { throttle: { enabled: true, globalMinMs: 0, perChatMinMs: 0 } },
      rateLimit: { redis: { enabled: true, required: true } }
    },
    async () => {},
    () => 1000,
    { reserve: async () => ({ status: 'unavailable' }) }
  );

  await assert.rejects(limiter.wait(-1001), (error) => error.code === 'RATE_LIMIT_SHARED_UNAVAILABLE');
});
