import assert from 'node:assert/strict';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { TelegramScanner, getBackfillPostAction, getInitialScanDays, getPostRetentionDays } from '../src/telegram/scanner.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('getInitialScanDays reads configured days and falls back to 60', () => {
  assert.equal(getInitialScanDays({ sync: { initialScanDays: 45 } }), 45);
  assert.equal(getInitialScanDays({ sync: {} }), 60);
});

test('getPostRetentionDays reads configured days and keeps minimum one day', () => {
  assert.equal(getPostRetentionDays({ sync: { retentionDays: 90 } }), 90);
  assert.equal(getPostRetentionDays({ sync: { retentionDays: 0 } }), 1);
  assert.equal(getPostRetentionDays({ sync: {} }), 60);
});

test('TelegramScanner.cleanupOldPosts deletes rows older than retention window', async () => {
  const calls = [];
  const scanner = new TelegramScanner({
    client: {},
    repository: {
      deletePostsOlderThan: async (chatId, beforeIso) => {
        calls.push({ chatId, beforeIso });
        return 3;
      }
    },
    config: {
      telegram: { sourceChatId: -1001 },
      sync: { retentionDays: 60, throttle: { enabled: false } }
    }
  });

  const deleted = await scanner.cleanupOldPosts(new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(deleted, 3);
  assert.deepEqual(calls, [{
    chatId: -1001,
    beforeIso: '2026-05-01T12:00:00.000Z'
  }]);
});

test('getBackfillPostAction adds missing old posts and updates only recent existing posts', () => {
  const sinceDate = new Date('2026-05-01T00:00:00.000Z');
  const updateSinceDate = new Date('2026-06-22T00:00:00.000Z');
  const existingIds = new Set([1, 2]);

  assert.equal(getBackfillPostAction({
    post: post(1, '2026-06-25T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'update');
  assert.equal(getBackfillPostAction({
    post: post(2, '2026-06-01T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'skip-existing-old');
  assert.equal(getBackfillPostAction({
    post: post(3, '2026-06-01T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'add');
  assert.equal(getBackfillPostAction({
    post: post(4, '2026-04-30T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'skip-old');
});

function post(messageId, messageDate) {
  return { messageId, messageDate };
}
