import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PostRepository } from '../src/database/postRepository.js';
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
      getPublicationByKey: async () => ({ id: 10, status: 'published' }),
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

  const result = await publisher.publishAll(new Date('2026-06-29T00:00:00.000Z'), ['best.week']);

  assert.equal(telegramCalls, 0);
  assert.deepEqual(result.selections, [{
    key: 'best.week',
    count: 1,
    status: 'exists',
    requested: false,
    publicationId: 10,
    publicationStatus: 'published',
    publicationKey: 'publish:best.week:2026-W27'
  }]);
});

test('SelectionPublisher handles concurrent publication scheduling collision without throwing', async () => {
  const dbPath = path.join('/private/tmp', `tg-memes-${process.pid}-${Date.now()}-publisher-collision.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();
  await repository.upsertPost({
    ...post(1, 'Alice'),
    chatId: -1002,
    messageDate: '2026-06-28T12:00:00.000Z'
  });

  const publisher = new SelectionPublisher({
    repository,
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

  const results = await Promise.all([
    publisher.publishAll(new Date('2026-06-29T00:00:00.000Z'), ['best.week']),
    publisher.publishAll(new Date('2026-06-29T00:00:00.000Z'), ['best.week'])
  ]);
  const statuses = results.map((result) => result.selections[0].status).sort();
  const rows = await repository.all('SELECT key, status FROM publications ORDER BY id');

  assert.deepEqual(statuses, ['exists', 'scheduled']);
  assert.deepEqual(rows, [{ key: 'publish:best.week:2026-W27', status: 'created' }]);

  await repository.close();
  await fs.rm(dbPath, { force: true });
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

test('SelectionPublisher.runManualSync runs sync worker and replies with result', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      sync: async (source) => {
        assert.equal(source, 'admin');
        return { status: 'running', key: 'sync', promise: Promise.resolve({ isInitial: false, seen: 10 }) };
      }
    },
    config: config()
  });

  await publisher.runManualSync({
    from: { id: 1 },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(replies, ['Sync job status: running']);
});

test('SelectionPublisher.runManualBackfill runs sync worker with optional days', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      backfill: async (days, source) => {
        assert.equal(days, 90);
        assert.equal(source, 'admin');
        return { status: 'busy', key: 'backfill:90', reason: 'busy', promise: Promise.resolve({ skipped: true }) };
      }
    },
    config: config()
  });

  await publisher.runManualBackfill({
    message: { text: '/backfill 90' },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(replies, ['Backfill job status: busy (busy)']);
});

test('SelectionPublisher.runManualPublish plans selections and replies with job status', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async () => 123,
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

  await publisher.runManualPublish({
    message: { text: '/publish best.week' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /best.week: scheduled \(1\)/);
  assert.match(replies[0], /Worker job status: running/);
});

test('SelectionPublisher.runManualPublish shows help without selection arguments', async () => {
  const replies = [];
  let loadedPosts = false;
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => {
        loadedPosts = true;
        return [post(1, 'Alice')];
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.runManualPublish({
    message: { text: '/publish' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(loadedPosts, false);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^Usage: \/publish <selection\.\.\.> \[--force\]/);
});

test('SelectionPublisher.runManualPublish shows help when only force flag is passed', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.runManualPublish({
    message: { text: '/publish -force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /^Usage: \/publish <selection\.\.\.> \[--force\]/);
});

test('SelectionPublisher.runManualPublish supports force scheduling', async () => {
  const keys = [];
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async ({ key }) => {
        keys.push(key);
        return 123;
      },
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

  await publisher.runManualPublish({
    message: { text: '/publish best.week --force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(keys.length, 1);
  assert.match(keys[0], /^publish:force:[a-z0-9]{6}:best\.week:2026-W27$/);
  assert.match(replies[0], /best.week: scheduled \(1\) forced/);
});

test('SelectionPublisher.runManualPublish supports single-dash force scheduling', async () => {
  const keys = [];
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async ({ key }) => {
        keys.push(key);
        return 123;
      },
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

  await publisher.runManualPublish({
    message: { text: '/publish best.week -force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(keys.length, 1);
  assert.match(keys[0], /^publish:force:[a-z0-9]{6}:best\.week:2026-W27$/);
  assert.match(replies[0], /best.week: scheduled \(1\) forced/);
});

test('SelectionPublisher.handleBotError replies to admin and does not throw', async () => {
  const replies = [];
  const logs = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });
  publisher.logger = {
    error: (message, fields) => logs.push({ message, fields })
  };

  await publisher.handleBotError(new Error('Unknown publish selection: blah'), {
    from: { id: 1 },
    chat: { id: 1, type: 'private' },
    message: { text: '/publish blah' },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(replies, ['Command failed: Unknown publish selection: blah']);
  assert.equal(logs[0].message, 'Bot command failed');
  assert.equal(logs[0].fields.command, 'publish');
});

test('SelectionPublisher.handleBotError ignores non-admin replies', async () => {
  let replied = false;
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });
  publisher.logger = { error: () => {} };

  await publisher.handleBotError(new Error('nope'), {
    from: { id: 2 },
    chat: { id: 2, type: 'private' },
    message: { text: '/publish blah' },
    reply: async () => {
      replied = true;
    }
  });

  assert.equal(replied, false);
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
    logging: { logLevel: 'silent' },
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
