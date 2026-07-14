import assert from 'node:assert/strict';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import {
  TelegramScanner,
  getBackfillPostAction,
  getInitialScanDays,
  getPostRetentionDays,
  needsNativeReactionEnrichment
} from '../src/telegram/scanner.js';

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

test('needsNativeReactionEnrichment detects native reaction parser and filter rules', () => {
  assert.equal(needsNativeReactionEnrichment({
    likes: [{ path: 'replyMarkup.rows[].buttons[].text', transform: 'count' }],
    dislikes: []
  }), false);
  assert.equal(needsNativeReactionEnrichment({
    likes: [{ path: 'reactionCounts[]', transform: 'reactionCount' }]
  }), true);
  assert.equal(needsNativeReactionEnrichment({
    filters: [{ path: 'messageReactions.results[]', transform: 'exists' }]
  }), true);
  assert.equal(needsNativeReactionEnrichment({
    dislikes: [{ path: 'customReactionRows[]', transform: 'reactionCount' }]
  }), true);
});

test('TelegramScanner skips reaction enrichment when parser only uses button counters', async () => {
  let reactionRequests = 0;
  const message = { id: 1, reactions: { results: [] } };
  const history = [message];
  history.next = null;
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async () => {
        reactionRequests += 1;
        return [];
      }
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'replyMarkup.rows[].buttons[].text', transform: 'count' }],
      dislikes: []
    })
  });

  await scanner.getHistory({ limit: 100 });

  assert.equal(reactionRequests, 0);
  assert.equal(message.nativeReactions, undefined);
});

test('TelegramScanner enriches all eligible messages in one reaction batch', async () => {
  let reactionRequests = 0;
  const first = { id: 1, reactions: { results: [] } };
  const withoutReactions = { id: 2 };
  const second = { id: 3, reactions: { results: [] } };
  const alreadyEnriched = { id: 4, reactions: { results: [] }, nativeReactions: [] };
  const history = [first, withoutReactions, second, alreadyEnriched];
  history.next = null;
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async (messages) => {
        reactionRequests += 1;
        assert.deepEqual(messages, [first, second]);
        return [
          { reactions: [{ reaction: '🔥', count: 7 }] },
          { reactions: [{ reaction: '👍', count: 11 }] }
        ];
      }
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'nativeReactions[]', transform: 'reactionCount' }],
      dislikes: []
    })
  });

  await scanner.getHistory({ limit: 100 });

  assert.equal(reactionRequests, 1);
  assert.deepEqual(first.nativeReactions, [{ reaction: '🔥', count: 7 }]);
  assert.deepEqual(second.nativeReactions, [{ reaction: '👍', count: 11 }]);
  assert.equal(withoutReactions.nativeReactions, undefined);
  assert.deepEqual(alreadyEnriched.nativeReactions, []);
});

test('TelegramScanner aborts an in-flight Telegram request during shutdown', async () => {
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => {
        requestStarted();
        return new Promise(() => {});
      }
    },
    repository: {},
    signal: controller.signal,
    config: scannerConfig({ likes: [], dislikes: [] })
  });

  const request = scanner.getHistory({ limit: 100 });
  await started;
  controller.abort(new Error('shutdown'));

  await assert.rejects(request, {
    code: 'TELEGRAM_OPERATION_CANCELLED',
    indeterminate: true
  });
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

function scannerConfig(parsing) {
  return {
    telegram: { sourceChatId: -1001 },
    parsing,
    sync: { pageSize: 100, throttle: { enabled: false } }
  };
}

test('TelegramScanner.scanBackfill reports stop reason when reaching the backfill window boundary', async () => {
  const saved = [];
  const scanner = new TelegramScanner({
    client: {},
    repository: {
      upsertPost: async (row) => saved.push(row.messageId)
    },
    config: {
      telegram: { sourceChatId: -1001 },
      parsing: {},
      sync: { pageSize: 100, throttle: { enabled: false } }
    }
  });
  scanner.getHistory = async () => {
    const rows = [
      telegramMessage(1, '2026-04-06T00:00:00.000Z'),
      telegramMessage(2, '2026-01-01T00:00:00.000Z')
    ];
    rows.next = 'older-page';
    return rows;
  };

  const result = await scanner.scanBackfill({
    sinceDate: new Date('2026-04-05T00:00:00.000Z'),
    updateSinceDate: new Date('2026-06-27T00:00:00.000Z'),
    existingIds: new Set()
  });

  assert.equal(result.stopReason, 'reached-since-date');
  assert.equal(result.fetched, 2);
  assert.equal(result.matched, 2);
  assert.equal(result.added, 1);
  assert.equal(result.skippedOld, 1);
  assert.deepEqual(saved, [1]);
});

function telegramMessage(id, isoDate) {
  return {
    id,
    date: new Date(isoDate),
    text: `By Author ${id}\nPost ${id}`
  };
}

test('TelegramScanner stops when Telegram repeats a pagination cursor', async () => {
  let calls = 0;
  const scanner = new TelegramScanner({
    client: {},
    repository: { upsertPost: async () => {} },
    config: {
      telegram: { sourceChatId: -1001 },
      parsing: {},
      sync: { pageSize: 100, maxPagesPerRun: 100, throttle: { enabled: false } }
    }
  });
  scanner.getHistory = async () => {
    calls += 1;
    const rows = [telegramMessage(calls, '2026-07-01T00:00:00.000Z')];
    rows.next = 'same-cursor';
    return rows;
  };

  await assert.rejects(
    scanner.scanSince(new Date('2026-06-01T00:00:00.000Z')),
    (error) => error.code === 'TELEGRAM_PAGINATION_STALLED'
  );
  assert.equal(calls, 2);
});
