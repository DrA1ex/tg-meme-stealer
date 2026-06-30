import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionPublisher } from '../src/telegram/publisher.js';

test('SelectionPublisher.waitForIdle waits for active handlers', async () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    config: config()
  });
  publisher.activeHandlers = 1;

  const wait = publisher.waitForIdle(100);
  let settled = false;
  wait.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  publisher.activeHandlers = 0;
  publisher.resolveIdle();
  await wait;

  assert.equal(settled, true);
});

test('SelectionPublisher.waitForIdle times out', async () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    config: config()
  });
  publisher.activeHandlers = 1;

  await publisher.waitForIdle(1);
  assert.equal(publisher.activeHandlers, 1);
});

test('SelectionPublisher.launchBot does not wait for polling promise', () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    config: config()
  });
  let launched = false;
  publisher.bot = {
    launch: () => {
      launched = true;
      return new Promise(() => {});
    }
  };

  publisher.launchBot();

  assert.equal(launched, true);
});

test('SelectionPublisher skips Telegram calls when publication request already exists', async () => {
  let telegramCalls = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async () => null,
      getNextPublicationRequest: async () => null
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          best: {
            week: { enabled: true, limit: 1, template: 'Best week' }
          }
        }
      }
    }
  });
  publisher.bot.telegram = {
    sendMessage: async () => {
      telegramCalls += 1;
    }
  };

  await publisher.publishAll(new Date('2026-06-29T00:00:00.000Z'), ['best.week']);

  assert.equal(telegramCalls, 0);
});

test('SelectionPublisher keeps request resumable when Telegram send fails', async () => {
  let errorId = null;
  const publisher = new SelectionPublisher({
    repository: {
      getNextPublicationRequest: async () => request({ id: 42, status: 'created' }),
      markPublicationRunning: async () => {},
      updatePublicationError: async (publicationId) => {
        errorId = publicationId;
      },
      listPublicationPosts: async () => []
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: { ...config(), publish: { dryRun: false } }
  });
  publisher.bot.telegram = {
    sendMessage: async () => {
      throw new Error('network failed');
    }
  };

  await assert.rejects(() => publisher.processPublicationQueue(), /network failed/);

  assert.equal(errorId, 42);
});

test('SelectionPublisher.unlockSyncLock releases durable sync lock', async () => {
  let releasedLockKey = '';
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      releaseJobLock: async (lockKey) => {
        releasedLockKey = lockKey;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.unlockSyncLock({
    from: { id: 1 },
    reply: async (message) => replies.push(message)
  });

  assert.equal(releasedLockKey, 'telegram:-1002:sync');
  assert.deepEqual(replies, ['Sync lock released: telegram:-1002:sync']);
});

test('SelectionPublisher.replyJobs returns admin jobs table', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      listPublicationJobs: async (options) => {
        assert.deepEqual(options, { finishedLimit: 5 });
        return {
          active: [{
            id: 2,
            status: 'running',
            selectionKey: 'best.week',
            sentCount: 1,
            expectedCount: 2,
            updatedAt: '2026-06-29T12:00:00.000Z'
          }],
          finished: [{
            id: 1,
            status: 'failed',
            selectionKey: 'best.day',
            sentCount: 0,
            expectedCount: 5,
            updatedAt: '2026-06-29T11:00:00.000Z',
            lastError: 'network failed'
          }]
        };
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.replyJobs({
    reply: async (message, options) => replies.push({ message, options })
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /Publication jobs/);
  assert.match(replies[0].message, /running/);
  assert.match(replies[0].message, /network failed/);
  assert.deepEqual(replies[0].options, { parse_mode: 'Markdown' });
});

test('SelectionPublisher.processPublicationQueue marks successful request as published', async () => {
  let finished = null;
  const rows = [];
  const publisher = new SelectionPublisher({
    repository: {
      getNextPublicationRequest: async () => rows.shift() || null,
      markPublicationRunning: async () => {},
      listPublicationPosts: async () => [],
      recordPublicationPost: async () => {},
      finishPublication: async (publicationId, payload) => {
        finished = { publicationId, payload };
      }
    },
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    config: { ...config(), publish: { dryRun: false } }
  });
  publisher.bot.telegram = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 })
  };
  rows.push(request({ id: 7, status: 'created' }));

  await publisher.processPublicationQueue();

  assert.equal(finished.publicationId, 7);
  assert.equal(finished.payload.status, 'published');
  assert.equal(finished.payload.posts.length, 2);
});

test('SelectionPublisher resumes running request from first unsent position', async () => {
  const sent = [];
  const recorded = [];
  const publisher = new SelectionPublisher({
    repository: {
      getNextPublicationRequest: async () => sent.length === 0 ? request({ id: 9, status: 'running' }) : null,
      listPublicationPosts: async () => [{ position: 1 }],
      recordPublicationPost: async (payload) => recorded.push(payload),
      finishPublication: async () => {}
    },
    mediaDownloader: {
      downloadPostMedia: async () => [],
      cleanupFiles: async () => {}
    },
    setupAssistant: null,
    config: { ...config(), publish: { dryRun: false, requestTtlHours: 12 } }
  });
  publisher.bot.telegram = {
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return { message_id: sent.length };
    }
  };

  await publisher.processPublicationQueue();

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Bob/);
  assert.equal(recorded[0].position, 2);
  assert.equal(recorded[0].post.messageId, 2);
});

function config() {
  return {
    telegram: {
      botToken: 'token',
      adminId: 1,
      publishChannelId: -1001,
      sourceChatId: -1002
    },
    logging: { level: 'silent' },
    publish: { dryRun: true },
    schedule: { timezone: 'UTC' },
    templates: {}
  };
}

function selection() {
  return {
    key: 'best.week',
    period: 'week',
    title: 'Best week',
    sinceIso: '2026-06-22T00:00:00.000Z',
    untilIso: '2026-06-29T00:00:00.000Z',
    posts: [post(1, 'Alice'), post(2, 'Bob')]
  };
}

function request(overrides = {}) {
  return {
    id: overrides.id || 1,
    key: 'publish:best.week:2026-W27',
    selectionKey: 'best.week',
    title: 'Best week',
    periodStart: '2026-06-22T00:00:00.000Z',
    periodEnd: '2026-06-29T00:00:00.000Z',
    status: overrides.status || 'created',
    data: { selection: selection() }
  };
}

function post(messageId, author) {
  return {
    chatId: -1001,
    messageId,
    author,
    text: `By ${author}`,
    likes: 10,
    dislikes: 1,
    data: { media: [] }
  };
}
