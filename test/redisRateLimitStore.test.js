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
      createClientFn: () => { throw new Error('invalid redis://worker:super-secret@redis.internal:6379 url'); }
    }
  );
  assert.equal(store, null);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][0], /could not be initialized.*local fallback/i);
  assert.doesNotMatch(logger.errors[0][1].error, /super-secret/);
  assert.match(logger.errors[0][1].error, /\[REDACTED\]/);
});

test('RedisRateLimitStore treats malformed validation replies as indeterminate failures', async () => {
  const logger = createTestLogger();
  const client = {
    isReady: true,
    isOpen: true,
    on: () => {},
    eval: async () => ['not-a-number']
  };
  const store = new RedisRateLimitStore({ client, config: {}, logger });

  assert.deepEqual(await store.validate({ blockKeys: ['global'], scheduledAt: 10 }), {
    status: 'indeterminate',
    backend: 'redis'
  });
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][0], /invalid validation result.*fallback/i);
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
    status: 'ok',
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

  assert.equal(await store.block({ keys: ['mtproto:main'], untilMs: Date.now() + 5000 }), 'ok');
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
  assert.deepEqual(await store.reserve({ slots: [{ key: 'x', intervalMs: 10 }] }), {
    status: 'unavailable',
    backend: 'redis'
  });
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][0], /unavailable.*local fallback/i);
  assert.match(logger.errors[0][1].error, /ECONNREFUSED/);
  assert.equal(logger.debugs.length, 1);
});

test('RedisRateLimitStore distinguishes an indeterminate operation timeout and opens its circuit', async () => {
  const logger = createTestLogger();
  const client = {
    isReady: true,
    isOpen: true,
    on: () => {},
    eval: async () => new Promise(() => {})
  };
  const store = new RedisRateLimitStore({
    client,
    config: { operationTimeoutMs: 5, circuitBreakMs: 1000 },
    logger
  });

  assert.deepEqual(await store.reserve({ slots: [{ key: 'x', intervalMs: 10 }] }), {
    status: 'indeterminate',
    backend: 'redis'
  });
  assert.deepEqual(await store.reserve({ slots: [{ key: 'x', intervalMs: 10 }] }), {
    status: 'unavailable',
    backend: 'redis'
  });
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0][1].error, /timed out/);
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
  const stores = await Promise.all([
    createRedisRateLimitStore(config, { logger: createTestLogger() }),
    createRedisRateLimitStore(config, { logger: createTestLogger() }),
    createRedisRateLimitStore(config, { logger: createTestLogger() })
  ]);
  const [first, second] = stores;
  try {
    const reservations = await Promise.all(stores.map((store) => store.reserve({
      slots: [{ key: 'shared', intervalMs: 500 }],
      blockKeys: ['global']
    })));
    const delays = reservations.map((item) => item.delayMs).sort((a, b) => a - b);
    assert.ok(delays[0] >= 0);
    assert.ok(delays[1] >= 400, `expected second shared delay, got ${delays[1]}ms`);
    assert.ok(delays[2] >= 900, `expected third shared delay, got ${delays[2]}ms`);
    await first.block({ keys: ['global'], untilMs: Date.now() + 1000 });
    const validation = await second.validate({
      blockKeys: ['global'],
      scheduledAt: reservations[0].scheduledAt
    });
    assert.equal(validation.status, 'ok');
    assert.equal(validation.invalidated, true);
    const blocked = await second.reserve({ slots: [{ key: 'other', intervalMs: 10 }], blockKeys: ['global'] });
    assert.ok(blocked.delayMs >= 850, `expected a shared cooldown, got ${blocked.delayMs}ms`);

    assert.equal(await first.recordFlood({
      blockKeys: ['flood-global'],
      penaltyKey: 'mtproto:main:reactions',
      durationMs: 100,
      factor: 2,
      max: 8
    }), 'ok');
    const penalized = await second.reserve({
      slots: [{ key: 'mtproto:main:reactions', intervalMs: 100 }],
      blockKeys: ['flood-global']
    });
    assert.equal(penalized.status, 'ok');
    assert.ok(penalized.penalty >= 2);
    assert.ok(penalized.delayMs >= 75);
  } finally {
    await Promise.all(stores.map((store) => store?.close()));
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
