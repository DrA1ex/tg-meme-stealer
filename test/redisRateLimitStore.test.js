import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisRateLimitStore, RedisRateLimitStore } from '../src/telegram/redisRateLimitStore.js';

test('createRedisRateLimitStore stays disabled without requiring a Redis server', async () => {
  assert.equal(await createRedisRateLimitStore({ rateLimit: { redis: { enabled: false } } }), null);
});

test('createRedisRateLimitStore logs ERROR and falls back if client initialization fails', async () => {
  const logger = createTestLogger();
  const store = await createRedisRateLimitStore(
    { rateLimit: { redis: { enabled: true } } },
    {
      logger,
      createClientFn: () => { throw new Error('invalid redis url'); }
    }
  );
  assert.equal(store, null);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][0], /could not be initialized.*local fallback/i);
});

test('RedisRateLimitStore maps reservations and cooldowns to atomic scripts', async () => {
  const evalCalls = [];
  const client = {
    isReady: true,
    isOpen: true,
    on: () => {},
    connect: async () => {},
    quit: async () => {},
    eval: async (_script, options) => {
      evalCalls.push(options);
      if (evalCalls.length === 1) return [450, 1000, 1450, '2'];
      return 1;
    }
  };
  const logger = createTestLogger();
  const store = new RedisRateLimitStore({ client, config: { keyPrefix: 'tests' }, logger });

  const reservation = await store.reserve({
    slots: [{ key: 'mtproto:main:reactions', intervalMs: 3000 }],
    blockKeys: ['mtproto:main']
  });
  assert.deepEqual(reservation, {
    delayMs: 450,
    nowMs: 1000,
    scheduledAt: 1450,
    penalty: 2,
    backend: 'redis'
  });
  assert.deepEqual(evalCalls[0].keys, [
    'tests:mtproto:main:reactions:next',
    'tests:mtproto:main:reactions:penalty',
    'tests:mtproto:main:blocked'
  ]);
  assert.deepEqual(evalCalls[0].arguments.slice(0, 4), ['1', '1', '86400000', '3000']);

  assert.equal(await store.block({ keys: ['mtproto:main'], untilMs: Date.now() + 5000 }), true);
  assert.match(evalCalls[1].keys[0], /mtproto:main:blocked$/);
});

test('RedisRateLimitStore logs ERROR and returns local fallback signal when Redis is unavailable', async () => {
  const logger = createTestLogger();
  const client = {
    isReady: false,
    isOpen: false,
    on: () => {},
    connect: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6379'); }
  };
  const store = new RedisRateLimitStore({ client, config: { warningIntervalMs: 30_000 }, logger });

  assert.equal(await store.start(), false);
  assert.equal(await store.reserve({ slots: [{ key: 'x', intervalMs: 10 }] }), null);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][0], /unavailable.*local fallback/i);
  assert.match(logger.errors[0][1].error, /ECONNREFUSED/);
  assert.equal(logger.debugs.length, 1);
});

test('RedisRateLimitStore coordinates reservations across real clients', {
  skip: !process.env.TEST_REDIS_URL
}, async () => {
  const prefix = `tg-memes:test:${process.pid}:${Date.now()}`;
  const config = {
    rateLimit: {
      redis: {
        enabled: true,
        url: process.env.TEST_REDIS_URL,
        keyPrefix: prefix,
        connectTimeoutMs: 1000,
        operationTimeoutMs: 1000
      }
    }
  };
  const first = await createRedisRateLimitStore(config, { logger: createTestLogger() });
  const second = await createRedisRateLimitStore(config, { logger: createTestLogger() });
  try {
    const one = await first.reserve({ slots: [{ key: 'shared', intervalMs: 500 }], blockKeys: ['global'] });
    const two = await second.reserve({ slots: [{ key: 'shared', intervalMs: 500 }], blockKeys: ['global'] });
    assert.ok(one.delayMs >= 0);
    assert.ok(two.delayMs >= 400, `expected a shared delay, got ${two.delayMs}ms`);
    await first.block({ keys: ['global'], untilMs: Date.now() + 1000 });
    const blocked = await second.reserve({ slots: [{ key: 'other', intervalMs: 10 }], blockKeys: ['global'] });
    assert.ok(blocked.delayMs >= 850, `expected a shared cooldown, got ${blocked.delayMs}ms`);
  } finally {
    await first?.close();
    await second?.close();
  }
});

function createTestLogger() {
  const logger = {
    debugs: [],
    infos: [],
    warns: [],
    errors: [],
    debug(message, fields) { this.debugs.push([message, fields]); },
    info(message, fields) { this.infos.push([message, fields]); },
    warn(message, fields) { this.warns.push([message, fields]); },
    error(message, fields) { this.errors.push([message, fields]); }
  };
  return logger;
}
