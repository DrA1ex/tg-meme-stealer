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
    mediaMaxMs: 900
  };

  assert.deepEqual(getTelegramThrottleRange(config, 'history'), { minMs: 800, maxMs: 1800 });
  assert.deepEqual(getTelegramThrottleRange(config, 'media'), { minMs: 300, maxMs: 900 });
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
  const throttle = new TelegramThrottle(
    { sync: { throttle: { historyMinMs: 10, historyMaxMs: 10 } } },
    async (ms) => waits.push(ms)
  );

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
