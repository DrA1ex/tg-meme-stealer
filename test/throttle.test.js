import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTelegramThrottleDelay,
  getTelegramThrottleRange,
  TelegramThrottle
} from '../src/telegram/throttle.js';

test('getTelegramThrottleRange reads per-kind ranges', () => {
  const config = {
    historyMinMs: 800,
    historyMaxMs: 1800,
    mediaMinMs: 300,
    mediaMaxMs: 900,
    reactionsMinMs: 3000,
    reactionsMaxMs: 4000
  };

  assert.deepEqual(getTelegramThrottleRange(config, 'history'), { minMs: 800, maxMs: 1800 });
  assert.deepEqual(getTelegramThrottleRange(config, 'media'), { minMs: 300, maxMs: 900 });
  assert.deepEqual(getTelegramThrottleRange(config, 'reactions'), { minMs: 3000, maxMs: 4000 });
});

test('getTelegramThrottleRange normalizes invalid and reversed values', () => {
  assert.deepEqual(getTelegramThrottleRange({ historyMinMs: 'bad', historyMaxMs: -10 }, 'history'), {
    minMs: 0,
    maxMs: 0
  });
  assert.deepEqual(getTelegramThrottleRange({ mediaMinMs: 900, mediaMaxMs: 300 }, 'media'), {
    minMs: 300,
    maxMs: 900
  });
});

test('getTelegramThrottleDelay returns deterministic jitter inside range', () => {
  assert.equal(getTelegramThrottleDelay({ historyMinMs: 100, historyMaxMs: 200 }, 'history', () => 0), 100);
  assert.equal(getTelegramThrottleDelay({ historyMinMs: 100, historyMaxMs: 200 }, 'history', () => 1), 200);
  assert.equal(getTelegramThrottleDelay({ historyMinMs: 100, historyMaxMs: 100 }, 'history'), 100);
});

test('TelegramThrottle waits unless disabled', async () => {
  const waits = [];
  let now = 1000;
  const throttle = new TelegramThrottle(
    { sync: { throttle: { historyMinMs: 10, historyMaxMs: 10 } } },
    async (ms) => { waits.push(ms); now += ms; },
    () => now
  );

  assert.equal(await throttle.wait('history'), 0);
  const delay = await throttle.wait('history');

  assert.equal(delay, 10);
  assert.deepEqual(waits, [10]);

  const disabled = new TelegramThrottle(
    { sync: { throttle: { enabled: false, historyMinMs: 10, historyMaxMs: 10 } } },
    async (ms) => waits.push(ms)
  );
  assert.equal(await disabled.wait('history'), 0);
  assert.deepEqual(waits, [10]);
});

test('TelegramThrottle honors FLOOD_WAIT globally and backs off the affected method', async () => {
  const waits = [];
  let now = 1000;
  const throttle = new TelegramThrottle(
    { sync: { throttle: { historyMinMs: 100, historyMaxMs: 100, retryBufferMs: 1000 } } },
    async (ms) => { waits.push(ms); now += ms; },
    () => now
  );

  await throttle.wait('history');
  await throttle.noteFloodWait('history', 2);
  assert.equal(await throttle.wait('media'), 3000);
  assert.equal(await throttle.wait('history'), 0);
  assert.equal(await throttle.wait('history'), 200);
  assert.deepEqual(waits, [3000, 200]);
});

test('TelegramThrottle uses shared reservations and publishes shared FLOOD_WAIT state', async () => {
  const calls = [];
  const sharedStore = {
    reserve: async (request) => { calls.push(['reserve', request]); return { delayMs: 750, penalty: 2 }; },
    block: async (request) => { calls.push(['block', request]); return true; },
    penalize: async (...args) => { calls.push(['penalize', args]); return 2; },
    reward: async (...args) => { calls.push(['reward', args]); return 1.9; }
  };
  let now = 1000;
  const throttle = new TelegramThrottle(
    {
      rateLimit: { mtprotoGroup: 'shared-account' },
      sync: { throttle: { reactionsMinMs: 3000, reactionsMaxMs: 3000, retryBufferMs: 1000 } }
    },
    async (ms) => { now += ms; },
    () => now,
    sharedStore
  );

  assert.equal(await throttle.wait('reactions'), 750);
  await throttle.noteFloodWait('reactions', 5);
  await throttle.noteSuccess('reactions');

  assert.equal(calls[0][1].slots[0].key, 'mtproto:shared-account:reactions');
  assert.equal(calls[1][0], 'block');
  assert.deepEqual(calls[1][1].keys, ['mtproto:shared-account']);
  assert.deepEqual(calls[2], ['penalize', ['mtproto:shared-account:reactions', 2, 8]]);
  assert.deepEqual(calls[3], ['reward', ['mtproto:shared-account:reactions', 0.95]]);
});

test('TelegramThrottle uses conservative local pacing while configured Redis is unavailable', async () => {
  let now = 1000;
  const waits = [];
  const throttle = new TelegramThrottle(
    {
      rateLimit: { redis: { enabled: true, fallbackMultiplier: 3 } },
      sync: { throttle: { reactionsMinMs: 1000, reactionsMaxMs: 1000 } }
    },
    async (ms) => { waits.push(ms); now += ms; },
    () => now,
    { reserve: async () => null }
  );

  assert.equal(await throttle.wait('reactions'), 3000);
  assert.equal(await throttle.wait('reactions'), 3000);
  assert.deepEqual(waits, [3000, 3000]);
});
