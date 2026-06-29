import test from 'node:test';
import assert from 'node:assert/strict';
import { getDelayUntilLocalTime, getNextLocalTimeAsDate } from '../src/runtime/scheduler.js';

test('getNextLocalTimeAsDate returns same-day target in timezone', () => {
  const target = getNextLocalTimeAsDate({
    now: new Date('2026-06-29T04:00:00.000Z'),
    time: '10:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(target.toISOString(), '2026-06-29T05:00:00.000Z');
});

test('getNextLocalTimeAsDate moves past times to next day', () => {
  const target = getNextLocalTimeAsDate({
    now: new Date('2026-06-29T06:00:00.000Z'),
    time: '09:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(target.toISOString(), '2026-06-30T04:00:00.000Z');
});

test('getDelayUntilLocalTime returns millisecond delay', () => {
  const delay = getDelayUntilLocalTime({
    now: new Date('2026-06-29T04:30:00.000Z'),
    time: '10:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(delay, 30 * 60 * 1000);
});
