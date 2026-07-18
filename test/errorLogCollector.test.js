import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorLogCollector, formatErrorDigest, getErrorType } from '../src/runtime/errorLogCollector.js';

class MemoryErrorRepository {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }

  async addPendingErrorLog(event) {
    const id = this.nextId++;
    this.rows.push({ id, ...structuredClone(event) });
    return id;
  }

  async listPendingErrorLogs() {
    return this.rows.map((row) => structuredClone(row));
  }

  async countPendingErrorLogs() {
    return this.rows.length;
  }

  async deletePendingErrorLogsThrough(maxId) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id > maxId);
    return before - this.rows.length;
  }
}

function errorEvent(message, fields = {}, now = '2026-07-18T06:00:00.000Z') {
  return {
    level: 'error',
    scope: 'media',
    message,
    fields,
    now: new Date(now)
  };
}

test('formatErrorDigest groups ERROR events by Telegram or explicit error code', () => {
  const text = formatErrorDigest([
    {
      timestamp: '2026-07-18T06:00:00.000Z',
      type: 'FILE_REFERENCE_EXPIRED',
      scope: 'media',
      message: 'Reference expired',
      error: 'Telegram API error 400: FILE_REFERENCE_EXPIRED'
    },
    {
      timestamp: '2026-07-18T06:01:00.000Z',
      type: 'FILE_REFERENCE_EXPIRED',
      scope: 'media',
      message: 'Reference expired again',
      error: 'Telegram API error 400: FILE_REFERENCE_EXPIRED'
    },
    {
      timestamp: '2026-07-18T06:02:00.000Z',
      type: 'REDIS_RESERVE_TIMEOUT',
      scope: 'rateLimit.redis',
      message: 'Shared limiter failed',
      error: 'Redis reserve timed out'
    }
  ]).join('\n');

  assert.match(text, /3 events, 2 types/);
  assert.match(text, /FILE_REFERENCE_EXPIRED × 2/);
  assert.match(text, /REDIS_RESERVE_TIMEOUT × 1/);
  assert.match(text, /Reference expired/);
  assert.match(text, /Reference expired again/);
  assert.match(text, /Shared limiter failed/);
});

test('formatErrorDigest includes diagnostic fields for every grouped event', () => {
  const text = formatErrorDigest([
    {
      timestamp: '2026-07-18T06:00:00.000Z',
      type: 'FILE_REFERENCE_EXPIRED',
      scope: 'media',
      message: 'Reference expired',
      error: 'Telegram API error 400: FILE_REFERENCE_EXPIRED',
      fields: { chatId: '-1001', messageId: 42, errorCode: 'FILE_REFERENCE_EXPIRED' }
    },
    {
      timestamp: '2026-07-18T06:01:00.000Z',
      type: 'FILE_REFERENCE_EXPIRED',
      scope: 'media',
      message: 'Another reference expired',
      error: 'Telegram API error 400: FILE_REFERENCE_EXPIRED',
      fields: { chatId: '-1001', messageId: 43 }
    }
  ]).join('\n');

  assert.match(text, /1\. 2026-07-18T06:00:00\.000Z \[media\] Reference expired/);
  assert.match(text, /2\. 2026-07-18T06:01:00\.000Z \[media\] Another reference expired/);
  assert.match(text, /\"messageId\":42/);
  assert.match(text, /\"messageId\":43/);
  assert.doesNotMatch(text, /\"errorCode\"/);
});

test('getErrorType prefers stable codes over free-form messages', () => {
  assert.equal(getErrorType({
    scope: 'media',
    message: 'Download failed',
    fields: { error: 'Telegram API error 400: FILE_REFERENCE_EXPIRED' }
  }), 'FILE_REFERENCE_EXPIRED');
  assert.equal(getErrorType({
    scope: 'rateLimit.redis',
    message: 'Shared limiter failed',
    fields: { error: 'Redis reserve timed out' }
  }), 'REDIS_RESERVE_TIMEOUT');
  assert.equal(getErrorType({
    scope: 'publisher',
    message: 'Publication failed',
    fields: { errorCode: 'CHANNEL_INVALID' }
  }), 'CHANNEL_INVALID');
});

test('ErrorLogCollector sends one atomic snapshot and preserves newer errors', async () => {
  const repository = new MemoryErrorRepository();
  const collector = new ErrorLogCollector({ repository });
  collector.record(errorEvent('First', { errorCode: 'FIRST_ERROR' }));
  collector.record(errorEvent('Second', { errorCode: 'SECOND_ERROR' }, '2026-07-18T06:01:00.000Z'));

  const messages = [];
  const result = await collector.flushPending({
    sendMessage: async (message) => {
      messages.push(message);
      collector.record(errorEvent('Arrived while sending', { errorCode: 'LATE_ERROR' }, '2026-07-18T06:02:00.000Z'));
    },
    title: 'Pending application ERROR logs'
  });

  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /FIRST_ERROR/);
  assert.match(messages[0], /SECOND_ERROR/);
  assert.doesNotMatch(messages[0], /LATE_ERROR/);
  const remaining = await repository.listPendingErrorLogs();
  assert.deepEqual(remaining.map((row) => row.type), ['LATE_ERROR']);
  await collector.close();
});

test('ErrorLogCollector retains pending rows when Telegram delivery fails', async () => {
  const repository = new MemoryErrorRepository();
  const collector = new ErrorLogCollector({ repository });
  collector.record(errorEvent('Cannot send', { errorCode: 'SEND_TEST' }));

  await assert.rejects(
    collector.flushPending({ sendMessage: async () => { throw new Error('Telegram unavailable'); } }),
    /Telegram unavailable/
  );

  assert.equal(await collector.pendingCount(), 1);
  await collector.close();
});

test('ErrorLogCollector schedules the daily digest for noon in the configured timezone', async () => {
  const repository = new MemoryErrorRepository();
  const timers = [];
  const now = Date.parse('2026-07-18T06:00:00.000Z');
  const collector = new ErrorLogCollector({
    repository,
    nowFn: () => now,
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {}
  });
  const messages = [];
  collector.record(errorEvent('Daily error', { errorCode: 'DAILY_ERROR' }));
  collector.setNotifier(async (message) => messages.push(message));
  collector.startDailyDigest({ timezone: 'Europe/Moscow', time: '12:00' });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 3 * 60 * 60 * 1000);
  assert.equal(timers[0].unrefCalled, true);

  await timers[0].fn();

  assert.equal(messages.length, 1);
  assert.match(messages[0], /Daily application ERROR digest/);
  assert.equal(await collector.pendingCount(), 0);
  assert.equal(timers.length, 2);
  await collector.close();
});

test('ErrorLogCollector does not send an empty daily digest', async () => {
  const repository = new MemoryErrorRepository();
  const timers = [];
  const collector = new ErrorLogCollector({
    repository,
    nowFn: () => Date.parse('2026-07-18T06:00:00.000Z'),
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {}
  });
  let sends = 0;
  collector.setNotifier(async () => { sends += 1; });
  collector.startDailyDigest({ timezone: 'Europe/Moscow', time: '12:00' });

  await timers[0].fn();

  assert.equal(sends, 0);
  assert.equal(timers.length, 2);
  await collector.close();
});

test('ErrorLogCollector redacts secrets before persistence', async () => {
  const repository = new MemoryErrorRepository();
  const collector = new ErrorLogCollector({ repository });
  collector.record(errorEvent('Sensitive error', {
    botToken: 'secret-token',
    nested: { apiHash: 'secret-hash', safe: 1 }
  }));
  await collector.pendingCount();

  const rows = await repository.listPendingErrorLogs();
  assert.equal(rows[0].fields.botToken, '[REDACTED]');
  assert.equal(rows[0].fields.nested.apiHash, '[REDACTED]');
  assert.equal(rows[0].fields.nested.safe, 1);
  await collector.close();
});
