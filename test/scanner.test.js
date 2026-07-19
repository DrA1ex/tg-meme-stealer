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
    indeterminate: false
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

test('TelegramScanner blocks reconciliation when more than 30 percent of expected recent posts are missing', async () => {
  const deleted = [];
  const scanner = reconciliationScanner({
    ids: Array.from({ length: 10 }, (_, index) => ({ messageId: index + 1 })),
    deleted
  });

  const result = await scanner.reconcileDeletedRecentPosts({
    sinceDate: new Date('2026-07-01T00:00:00.000Z'),
    seenIds: new Set([1, 2, 3, 4, 5, 6]),
    authoritativeComplete: true
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'missing_ratio_exceeded');
  assert.equal(result.missingRatio, 0.4);
  assert.deepEqual(deleted, []);
});

test('TelegramScanner force reconciliation accepts a known large difference', async () => {
  const deleted = [];
  const scanner = reconciliationScanner({
    ids: Array.from({ length: 10 }, (_, index) => ({ messageId: index + 1 })),
    deleted
  });

  const result = await scanner.reconcileDeletedRecentPosts({
    sinceDate: new Date('2026-07-01T00:00:00.000Z'),
    seenIds: new Set([1, 2, 3, 4, 5, 6]),
    authoritativeComplete: true,
    force: true
  });

  assert.equal(result.blocked, false);
  assert.equal(result.forced, true);
  assert.equal(result.deleted, 4);
  assert.deepEqual(deleted, [7, 8, 9, 10]);
});

test('TelegramScanner never reconciles deletions from an incomplete history scan', async () => {
  const deleted = [];
  const scanner = reconciliationScanner({ ids: [{ messageId: 1 }, { messageId: 2 }], deleted });

  const result = await scanner.reconcileDeletedRecentPosts({
    sinceDate: new Date('2026-07-01T00:00:00.000Z'),
    seenIds: new Set(),
    authoritativeComplete: false,
    force: true
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'incomplete_scan');
  assert.deepEqual(deleted, []);
});

test('TelegramScanner distinguishes expected history exhaustion from an unexpected empty page', async () => {
  const expected = new TelegramScanner({
    client: {},
    repository: { upsertPost: async () => {} },
    config: scanConfig()
  });
  const expectedPage = [];
  expectedPage.next = null;
  expected.getHistory = async () => expectedPage;

  const expectedResult = await expected.scanSince(new Date('2026-07-01T00:00:00.000Z'));
  assert.equal(expectedResult.authoritativeComplete, true);
  assert.equal(expectedResult.stopReason, 'history-exhausted-empty');

  const unexpected = new TelegramScanner({
    client: {},
    repository: { upsertPost: async () => {} },
    config: scanConfig()
  });
  const unexpectedPage = [];
  unexpectedPage.next = 'older';
  unexpected.getHistory = async () => unexpectedPage;

  const unexpectedResult = await unexpected.scanSince(new Date('2026-07-01T00:00:00.000Z'));
  assert.equal(unexpectedResult.authoritativeComplete, false);
  assert.equal(unexpectedResult.stopReason, 'unexpected-empty-page');
});

test('TelegramScanner assembles an album split across history pages before parsing it', async () => {
  const saved = [];
  const scanner = new TelegramScanner({
    client: {},
    repository: { upsertPost: async (post) => saved.push(post) },
    config: scanConfig()
  });
  const pages = [
    historyPage([
      albumMessage(5, '2026-07-10T12:00:00.000Z', null, 'By Solo\nSolo'),
      albumMessage(4, '2026-07-10T11:00:00.000Z', 'album-1', 'By Album\nCaption')
    ], 'page-2'),
    historyPage([
      albumMessage(3, '2026-07-10T10:59:00.000Z', 'album-1', ''),
      albumMessage(2, '2026-07-10T10:00:00.000Z', null, 'By Older\nOlder')
    ], null)
  ];
  scanner.getHistory = async () => pages.shift();

  const result = await scanner.scanSince(new Date('2026-07-01T00:00:00.000Z'));

  assert.equal(result.authoritativeComplete, true);
  assert.equal(result.pages, 2);
  assert.equal(saved.length, 3);
  const album = saved.find((post) => post.author === 'Album');
  assert.ok(album);
  assert.equal(album.data.media.length, 2);
  assert.deepEqual(album.data.media.map((item) => item.messageId), [3, 4]);
});

function reconciliationScanner({ ids, deleted }) {
  return new TelegramScanner({
    client: {},
    repository: {
      listPostIdsSince: async () => ids,
      deletePost: async (_chatId, messageId) => { deleted.push(messageId); }
    },
    config: scanConfig()
  });
}

function scanConfig() {
  return {
    telegram: { sourceChatId: -1001 },
    parsing: {},
    sync: {
      pageSize: 2,
      maxPagesPerRun: 20,
      maxMissingRatio: 0.3,
      throttle: { enabled: false }
    }
  };
}

function historyPage(messages, next) {
  messages.next = next;
  return messages;
}

function albumMessage(id, isoDate, groupedId, text) {
  return {
    id,
    date: new Date(isoDate),
    groupedId,
    text,
    media: { type: 'photo', fileSize: 10 }
  };
}

test('TelegramScanner fails synchronization when required native reaction enrichment fails', async () => {
  const message = { id: 1, reactions: { results: [] } };
  const history = [message];
  history.next = null;
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async () => { throw new Error('reaction endpoint unavailable'); }
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'nativeReactions[]', transform: 'reactionCount' }],
      dislikes: []
    })
  });

  await assert.rejects(
    scanner.getHistory({ limit: 100 }),
    (error) => error.code === 'NATIVE_REACTIONS_UNAVAILABLE' && error.telegramFailureScope === 'source'
  );
});

test('TelegramScanner compares history reaction summaries while keeping getMessageReactions authoritative', async () => {
  const message = {
    id: 101,
    reactions: {
      results: [
        { reaction: '👍', count: 4 },
        { reaction: '👎', count: 1 }
      ]
    }
  };
  const history = [message];
  history.next = null;
  const reactionVerification = { compared: 0, matched: 0, mismatched: 0, examples: [] };
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async () => [{
        reactions: [
          { reaction: '👍', count: 6 },
          { reaction: '👎', count: 1 }
        ]
      }]
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'nativeReactions[]', transform: 'reactionCount', emojis: ['👍'] }],
      dislikes: [{ path: 'nativeReactions[]', transform: 'reactionCount', emojis: ['👎'] }]
    })
  });

  await scanner.getHistory({ limit: 100 }, scanner.config.parsing, { reactionVerification });

  assert.deepEqual(message.nativeReactions, [
    { reaction: '👍', count: 6 },
    { reaction: '👎', count: 1 }
  ]);
  assert.deepEqual(reactionVerification, {
    compared: 1,
    matched: 0,
    mismatched: 1,
    examples: [{
      messageId: 101,
      history: { '👍': 4, '👎': 1 },
      full: { '👍': 6, '👎': 1 }
    }]
  });
});

test('TelegramScanner records matching history and full reaction summaries', async () => {
  const message = { id: 102, reactions: { results: [{ reaction: '🔥', count: 7 }] } };
  const history = [message];
  history.next = null;
  const reactionVerification = { compared: 0, matched: 0, mismatched: 0, examples: [] };
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async () => [{ reactions: [{ reaction: '🔥', count: 7 }] }]
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'nativeReactions[]', transform: 'reactionCount', emojis: ['🔥'] }],
      dislikes: []
    })
  });

  await scanner.getHistory({ limit: 100 }, scanner.config.parsing, { reactionVerification });

  assert.deepEqual(reactionVerification, { compared: 1, matched: 1, mismatched: 0, examples: [] });
});

test('TelegramScanner treats an empty getMessageReactions result as authoritative', async () => {
  const message = { id: 103, reactions: { results: [{ reaction: '👍', count: 2 }] } };
  const history = [message];
  history.next = null;
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async () => [{}]
    },
    repository: {},
    config: scannerConfig({
      likes: [{ path: 'nativeReactions[]', transform: 'reactionCount', emojis: ['👍'] }],
      dislikes: []
    })
  });

  await scanner.getHistory({ limit: 100 });

  assert.deepEqual(message.nativeReactions, []);
  assert.deepEqual(message.reactionCounts, []);
});

test('TelegramScanner does not request full reactions for messages outside the sync window', async () => {
  const recent = telegramMessage(201, '2026-07-10T00:00:00.000Z');
  recent.reactions = { results: [{ reaction: '👍', count: 1 }] };
  const old = telegramMessage(200, '2026-06-01T00:00:00.000Z');
  old.reactions = { results: [{ reaction: '👍', count: 9 }] };
  const history = [recent, old];
  history.next = 'older';
  const requestedIds = [];
  const saved = [];
  const scanner = new TelegramScanner({
    client: {
      getHistory: async () => history,
      getMessageReactions: async (messages) => {
        requestedIds.push(messages.map((message) => message.id));
        return messages.map((message) => ({ reactions: message.reactions.results }));
      }
    },
    repository: { upsertPosts: async (posts) => saved.push(...posts) },
    config: {
      telegram: { sourceChatId: -1001 },
      parsing: {
        likes: [{ path: 'nativeReactions[]', transform: 'reactionCount', emojis: ['👍'] }],
        dislikes: []
      },
      sync: { pageSize: 100, maxPagesPerRun: 10, throttle: { enabled: false } }
    }
  });

  const result = await scanner.scanSince(new Date('2026-07-01T00:00:00.000Z'));

  assert.deepEqual(requestedIds, [[201]]);
  assert.deepEqual(saved.map((post) => post.messageId), [201]);
  assert.equal(result.reactionVerification.compared, 1);
});

test('TelegramScanner writes one parsed page through repository.upsertPosts', async () => {
  const batches = [];
  const scanner = new TelegramScanner({
    client: {},
    repository: {
      upsertPosts: async (posts) => batches.push(posts.map((post) => post.messageId)),
      upsertPost: async () => { throw new Error('single-row upsert should not be used'); }
    },
    config: scanConfig()
  });
  const page = historyPage([
    telegramMessage(301, '2026-07-10T00:00:00.000Z'),
    telegramMessage(300, '2026-07-09T00:00:00.000Z')
  ], null);
  scanner.getHistory = async () => page;

  await scanner.scanSince(new Date('2026-07-01T00:00:00.000Z'));

  assert.deepEqual(batches, [[301, 300]]);
});

test('TelegramScanner reconciliation uses repository.deletePosts when available', async () => {
  const calls = [];
  const scanner = new TelegramScanner({
    client: {},
    repository: {
      listPostIdsSince: async () => [{ messageId: 1 }, { messageId: 2 }, { messageId: 3 }],
      deletePosts: async (chatId, ids) => {
        calls.push({ chatId, ids });
        return ids.length;
      },
      deletePost: async () => { throw new Error('single-row delete should not be used'); }
    },
    config: scanConfig()
  });

  const result = await scanner.reconcileDeletedRecentPosts({
    sinceDate: new Date('2026-07-01T00:00:00.000Z'),
    seenIds: new Set([1]),
    authoritativeComplete: true,
    force: true
  });

  assert.equal(result.deleted, 2);
  assert.deepEqual(calls, [{ chatId: -1001, ids: [2, 3] }]);
});
