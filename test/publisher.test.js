import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { PostRepository } from '../src/database/postRepository.js';
import { SelectionPublisher } from '../src/telegram/publisher.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

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
  let postQueries = 0;
  let insertAttempts = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getTopPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => {
        insertAttempts += 1;
        return null;
      },
      getPublicationByKey: async () => ({ id: 10, status: 'published', data: { count: 1 } }),
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
  assert.equal(postQueries, 0);
  assert.equal(insertAttempts, 0);
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

test('SelectionPublisher scheduled enqueue skips existing publication before selecting posts', async () => {
  let postQueries = 0;
  let insertAttempts = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => ({ id: 20, status: 'published', data: { count: 3 } }),
      getTopPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => {
        insertAttempts += 1;
        return 123;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          best: {
            week: { enabled: true, limit: 10, template: 'Best week' }
          }
        }
      }
    }
  });

  const job = publisher.schedulePublicationRequestFromSchedule('best.week', new Date('2026-06-29T00:00:00.000Z'));
  const result = await job.promise;

  assert.equal(job.status, 'running');
  assert.equal(postQueries, 0);
  assert.equal(insertAttempts, 0);
  assert.deepEqual(result.selections, [{
    key: 'best.week',
    status: 'exists',
    requested: false,
    count: 3,
    publicationId: 20,
    publicationStatus: 'published',
    publicationKey: 'publish:best.week:2026-W27'
  }]);
});

test('SelectionPublisher scheduled enqueue skips same canonical key but queues different keys', async () => {
  let releaseFirst;
  const events = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async (key) => {
        events.push(`exists:${key}`);
        if (key === 'publish:best.week:2026-W27') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return null;
      },
      getTopPosts: async ({ period }) => {
        events.push(`posts:${period}`);
        return [post(period === 'week' ? 1 : 2, 'Alice')];
      },
      tryCreatePublicationRequest: async ({ key }) => {
        events.push(`insert:${key}`);
        return key.endsWith('2026-W27') ? 101 : 102;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          best: {
            week: { enabled: true, limit: 1, template: 'Best week' },
            day: { enabled: true, limit: 1, template: 'Best day' }
          }
        }
      }
    }
  });

  const first = publisher.schedulePublicationRequestFromSchedule('best.week', new Date('2026-06-29T00:00:00.000Z'));
  const duplicate = publisher.schedulePublicationRequestFromSchedule('best.week', new Date('2026-06-29T00:00:00.000Z'));
  const different = publisher.schedulePublicationRequestFromSchedule('best.day', new Date('2026-06-29T00:00:00.000Z'));

  assert.equal(first.status, 'running');
  assert.equal(duplicate.status, 'skipped');
  assert.equal(duplicate.reason, 'duplicate_job');
  assert.equal(different.status, 'scheduled');

  await Promise.resolve();
  assert.deepEqual(events, ['exists:publish:best.week:2026-W27']);

  releaseFirst();
  const firstResult = await first.promise;
  const differentResult = await different.promise;

  assert.equal(firstResult.selections[0].status, 'scheduled');
  assert.equal(differentResult.selections[0].status, 'scheduled');
  assert.deepEqual(events, [
    'exists:publish:best.week:2026-W27',
    'posts:week',
    'insert:publish:best.week:2026-W27',
    'exists:publish:best.day:2026-06-29',
    'posts:day',
    'insert:publish:best.day:2026-06-29'
  ]);
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
      getPublicationByKey: async () => null,
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
  assert.match(replies[0], /best\.week: publication request created \(1 posts\)/);
  assert.match(replies[0], /Worker job status: running/);
});

test('SelectionPublisher.runManualPublish replies when requested publication already exists', async () => {
  const replies = [];
  let loadedPosts = false;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => ({ id: 10, status: 'published', data: { count: 5 } }),
      getTopPosts: async () => {
        loadedPosts = true;
        return [post(1, 'Alice')];
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          best: {
            day: { enabled: true, limit: 5, template: 'Best day' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish day' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(loadedPosts, false);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /best\.day: already published\. Nothing was scheduled\./);
  assert.match(replies[0], /No new publication request was created\. Worker was not started\./);
});

test('SelectionPublisher.runManualPublish does not create publication request when period has no posts', async () => {
  const replies = [];
  let insertAttempted = false;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getTopPosts: async () => [],
      tryCreatePublicationRequest: async () => {
        insertAttempted = true;
        return 123;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          best: {
            day: { enabled: true, limit: 5, template: 'Best day' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish day' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(insertAttempted, false);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /best\.day: no matching posts, nothing was scheduled/);
  assert.match(replies[0], /No new publication request was created\. Worker was not started\./);
});

test('SelectionPublisher.runManualPublish supports best and controversial wildcards', async () => {
  const topSpecs = [];
  const controversialSpecs = [];
  const insertedKeys = [];
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getTopPosts: async (spec) => {
        topSpecs.push(spec.key);
        return [post(topSpecs.length, 'Alice')];
      },
      getControversialPosts: async (spec) => {
        controversialSpecs.push(spec.key);
        return [post(10 + controversialSpecs.length, 'Bob')];
      },
      tryCreatePublicationRequest: async ({ key }) => {
        insertedKeys.push(key);
        return insertedKeys.length;
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
            month: { enabled: true, limit: 1, template: 'Best month' },
            week: { enabled: true, limit: 1, template: 'Best week' },
            day: { enabled: true, limit: 1, template: 'Best day' }
          },
          controversial: {
            month: { enabled: true, limit: 1, threshold: 0.3, template: 'Controversial month' },
            week: { enabled: true, limit: 1, threshold: 0.3, template: 'Controversial week' },
            day: { enabled: true, limit: 1, threshold: 0.3, template: 'Controversial day' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish best.* controversial.*' },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(topSpecs, ['best.month', 'best.week', 'best.day']);
  assert.deepEqual(controversialSpecs, ['controversial.month', 'controversial.week', 'controversial.day']);
  assert.equal(insertedKeys.length, 6);
  assert.match(replies[0], /best\.month: publication request created/);
  assert.match(replies[0], /controversial\.day: publication request created/);
});

test('SelectionPublisher.runManualPublish force schedules an explicitly disabled selection', async () => {
  const replies = [];
  const queried = [];
  const insertedKeys = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getControversialPosts: async (spec) => {
        queried.push(spec.key);
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async ({ key }) => {
        insertedKeys.push(key);
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
          controversial: {
            week: { enabled: false, limit: 1, threshold: 0.3, template: 'Controversial week' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish controversial.week -force' },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(queried, ['controversial.week']);
  assert.equal(insertedKeys.length, 1);
  assert.match(insertedKeys[0], /^publish:force:[a-z0-9]{6}:controversial\.week:2026-W27$/);
  assert.match(replies[0], /controversial\.week: publication request created \(1 posts\) forced/);
});

test('SelectionPublisher.runManualPublish explains when worker is already running', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getControversialPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async () => 123
    },
    mediaDownloader: {},
    setupAssistant: null,
    jobGate: {
      run: () => ({
        status: 'skipped',
        key: 'publish-worker',
        reason: 'duplicate_job',
        promise: Promise.resolve({ skipped: true })
      })
    },
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          controversial: {
            day: { enabled: false, limit: 3, threshold: 0.3, template: 'Controversial day' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish controversial.day -force' },
    reply: async (message) => replies.push(message)
  });

  assert.match(replies[0], /controversial\.day: publication request created \(1 posts\) forced/);
  assert.match(replies[0], /Worker is already running\. The created publication request will be processed by the active worker\./);
  assert.doesNotMatch(replies[0], /Worker job status: skipped/);
});

test('SelectionPublisher.runManualPublish does not schedule disabled selection without force', async () => {
  const replies = [];
  let queried = false;
  const publisher = new SelectionPublisher({
    repository: {
      getControversialPosts: async () => {
        queried = true;
        return [post(1, 'Alice')];
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        selections: {
          controversial: {
            week: { enabled: false, limit: 1, threshold: 0.3, template: 'Controversial week' }
          }
        }
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish controversial.week' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(queried, false);
  assert.deepEqual(replies, ['No enabled selections matched. Use -force to publish an explicitly disabled selection.']);
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
      getPublicationByKey: async () => null,
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
  assert.match(replies[0], /best\.week: publication request created \(1 posts\) forced/);
});

test('SelectionPublisher.runManualPublish supports single-dash force scheduling', async () => {
  const keys = [];
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
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
  assert.match(replies[0], /best\.week: publication request created \(1 posts\) forced/);
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

test('SelectionPublisher.replyPublications returns recent publications table', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      listRecentPublications: async (options) => {
        assert.deepEqual(options, { limit: 10 });
        return [{
          id: 7,
          key: 'publish:best.week:2026-W27',
          status: 'published',
          selectionKey: 'best.week',
          title: 'Best week',
          sentCount: 10,
          expectedCount: 10,
          updatedAt: '2026-06-29T12:00:00.000Z'
        }];
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.replyPublications({
    reply: async (message, options) => replies.push({ message, options })
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /Publications/);
  assert.match(replies[0].message, /publish:best\.week:2026-W27/);
  assert.match(replies[0].message, /10\/10/);
  assert.doesNotMatch(replies[0].message, /updated/i);
  assert.doesNotMatch(replies[0].message, /\bselection\b/i);
  assert.doesNotMatch(replies[0].message, /\btitle\b/i);
  assert.deepEqual(replies[0].options, { parse_mode: 'Markdown' });
});

test('SelectionPublisher.replyPublication returns publication posts table', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationById: async (id) => {
        assert.equal(id, 7);
        return {
          id: 7,
          status: 'published',
          selectionKey: 'best.week',
          title: 'Best week',
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T11:00:00.000Z',
          finishedAt: '2026-06-29T12:00:00.000Z'
        };
      },
      listPublicationPostsDetailed: async (id) => {
        assert.equal(id, 7);
        return [{
          position: 1,
          messageId: 123,
          likes: 50,
          dislikes: 2,
          sentAt: '2026-06-29T12:00:00.000Z',
          botMessageId: 456,
          author: 'Alice'
        }];
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });

  await publisher.replyPublication({
    message: { text: '/publication 7' },
    reply: async (message, options) => replies.push({ message, options })
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /Publication #7/);
  assert.match(replies[0].message, /Created: 2026-06-29 10:00:00Z/);
  assert.match(replies[0].message, /Finished: 2026-06-29 12:00:00Z/);
  assert.doesNotMatch(replies[0].message, /Updated:/);
  assert.match(replies[0].message, /123/);
  assert.match(replies[0].message, /Alice/);
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
