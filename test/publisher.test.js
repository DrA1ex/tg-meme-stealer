import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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
  assert.equal(publisher.idleResolvers.length, 0);
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
      getSelectionPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => {
        insertAttempts += 1;
        return null;
      },
      getPublicationByKey: async () => ({
        id: 10,
        status: 'published',
        get data() {
          throw new Error('duplicate path must not read publication data count');
        }
      }),
      getNextPublicationRequest: async () => null
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' }
        ]
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
    status: 'exists',
    requested: false,
    publicationId: 10,
    publicationStatus: 'published',
    publicationKey: 'publish:best:week:2026-06-29T00-00'
  }]);
});

test('SelectionPublisher handles concurrent publication scheduling collision without throwing', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-publisher-collision.sqlite`);
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
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' }
        ]
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
  assert.deepEqual(rows, [{ key: 'publish:best:week:2026-06-29T00-00', status: 'created' }]);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('SelectionPublisher publication key does not depend on selected post count', async () => {
  async function planWithPostCount(count) {
    const insertedKeys = [];
    const publisher = new SelectionPublisher({
      repository: {
        getPublicationByKey: async () => null,
        getSelectionPosts: async () => Array.from({ length: count }, (_, index) => post(index + 1, 'Alice')),
        tryCreatePublicationRequest: async ({ key }) => {
          insertedKeys.push(key);
          return count;
        }
      },
      mediaDownloader: {},
      setupAssistant: null,
      config: {
        ...config(),
        publish: {
          dryRun: false,
          template: [
            { source: 'best', key: 'week', enabled: true, limit: 10, template: 'Best week' }
          ]
        }
      }
    });

    const result = await publisher.publishAll(new Date('2026-06-29T00:00:00.000Z'), ['best.week']);
    return { result, insertedKeys };
  }

  const onePost = await planWithPostCount(1);
  const threePosts = await planWithPostCount(3);

  assert.equal(onePost.result.selections[0].count, 1);
  assert.equal(threePosts.result.selections[0].count, 3);
  assert.deepEqual(onePost.insertedKeys, ['publish:best:week:2026-06-29T00-00']);
  assert.deepEqual(threePosts.insertedKeys, ['publish:best:week:2026-06-29T00-00']);
});

test('SelectionPublisher canonical publication key uses scheduledAt with offset windows', async () => {
  const checkedKeys = [];
  const inserted = [];
  const queriedSpecs = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async (key) => {
        checkedKeys.push(key);
        return null;
      },
      getSelectionPosts: async (spec) => {
        queriedSpecs.push(spec);
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async (request) => {
        inserted.push(request);
        return 123;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'last_week_day', enabled: true, windowHours: 24, offsetHours: 168, limit: 1, template: 'Best shifted day' }
        ]
      }
    }
  });

  const result = await publisher.publishAll(new Date('2026-07-08T10:00:00.000Z'), ['best.last_week_day']);

  assert.equal(result.selections[0].status, 'scheduled');
  assert.deepEqual(checkedKeys, ['publish:best:last_week_day:2026-07-08T10-00']);
  assert.equal(inserted[0].key, 'publish:best:last_week_day:2026-07-08T10-00');
  assert.equal(inserted[0].periodStart, '2026-06-30T10:00:00.000Z');
  assert.equal(inserted[0].periodEnd, '2026-07-01T10:00:00.000Z');
  assert.equal(queriedSpecs[0].scheduledAtIso, '2026-07-08T10:00:00.000Z');
});

test('SelectionPublisher canonical key follows scheduled run bucket, not window or offset', async () => {
  async function planWithTiming({ templateKey, schedule, scheduledAt, windowHours, offsetHours }) {
    const inserted = [];
    const publisher = new SelectionPublisher({
      repository: {
        getPublicationByKey: async () => null,
        getSelectionPosts: async () => [post(1, 'Alice')],
        tryCreatePublicationRequest: async (request) => {
          inserted.push(request);
          return 123;
        }
      },
      mediaDownloader: {},
      setupAssistant: null,
      config: {
        ...config(),
        publish: {
          dryRun: false,
          template: [
            {
              source: 'best',
              key: templateKey,
              enabled: true,
              schedule,
              windowHours,
              offsetHours,
              limit: 1,
              template: 'Best posts'
            }
          ]
        }
      }
    });

    await publisher.publishAll(new Date(scheduledAt), [`best.${templateKey}`]);
    return inserted[0];
  }

  const currentWeek = await planWithTiming({
    templateKey: 'weekly_best',
    schedule: { type: 'weekly', weekday: 1, time: '10:10' },
    scheduledAt: '2026-06-29T05:10:00.000Z',
    windowHours: 168,
    offsetHours: 0
  });
  const shiftedWeek = await planWithTiming({
    templateKey: 'weekly_best',
    schedule: { type: 'weekly', weekday: 1, time: '10:10' },
    scheduledAt: '2026-06-29T05:10:00.000Z',
    windowHours: 24,
    offsetHours: 168
  });
  const currentMonth = await planWithTiming({
    templateKey: 'monthly_best',
    schedule: { type: 'monthly', dayOfMonth: 1, time: '10:20' },
    scheduledAt: '2026-07-01T05:20:00.000Z',
    windowHours: 720,
    offsetHours: 0
  });
  const shiftedMonth = await planWithTiming({
    templateKey: 'monthly_best',
    schedule: { type: 'monthly', dayOfMonth: 1, time: '10:20' },
    scheduledAt: '2026-07-01T05:20:00.000Z',
    windowHours: 24,
    offsetHours: 720
  });

  assert.equal(currentWeek.key, 'publish:best:weekly_best:2026-06-29T05-10');
  assert.equal(shiftedWeek.key, 'publish:best:weekly_best:2026-06-29T05-10');
  assert.equal(currentWeek.periodStart, '2026-06-22T05:10:00.000Z');
  assert.equal(currentWeek.periodEnd, '2026-06-29T05:10:00.000Z');
  assert.equal(shiftedWeek.periodStart, '2026-06-21T05:10:00.000Z');
  assert.equal(shiftedWeek.periodEnd, '2026-06-22T05:10:00.000Z');
  assert.equal(currentMonth.key, 'publish:best:monthly_best:2026-07-01T05-20');
  assert.equal(shiftedMonth.key, 'publish:best:monthly_best:2026-07-01T05-20');
  assert.equal(currentMonth.periodStart, '2026-06-01T05:20:00.000Z');
  assert.equal(currentMonth.periodEnd, '2026-07-01T05:20:00.000Z');
  assert.equal(shiftedMonth.periodStart, '2026-05-31T05:20:00.000Z');
  assert.equal(shiftedMonth.periodEnd, '2026-06-01T05:20:00.000Z');
});

test('SelectionPublisher firstSendAt compares against scheduledAt, not shifted window end', async () => {
  let postQueries = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => 123
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          {
            source: 'best',
            key: 'last_week_day',
            enabled: true,
            windowHours: 24,
            offsetHours: 168,
            limit: 1,
            firstSendAt: '2026-07-08T09:00:00.000Z',
            template: 'Best shifted day'
          }
        ]
      }
    }
  });

  const result = await publisher.publishAll(new Date('2026-07-08T10:00:00.000Z'), ['best.last_week_day']);

  assert.equal(postQueries, 1);
  assert.equal(result.selections[0].status, 'scheduled');
});

test('SelectionPublisher scheduled enqueue skips existing publication before selecting posts', async () => {
  let postQueries = 0;
  let insertAttempts = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => ({
        id: 20,
        status: 'published',
        get data() {
          throw new Error('duplicate path must not read publication data count');
        }
      }),
      getSelectionPosts: async () => {
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
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 10, template: 'Best week' }
        ]
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
    publicationId: 20,
    publicationStatus: 'published',
    publicationKey: 'publish:best:week:2026-06-29T00-00'
  }]);
});

test('SelectionPublisher scheduled enqueue skips same canonical key but queues different keys', async () => {
  let releaseFirst;
  const events = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async (key) => {
        events.push(`exists:${key}`);
        if (key === 'publish:best:week:2026-06-29T00-00') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return null;
      },
      getSelectionPosts: async ({ period }) => {
        events.push(`posts:${period}`);
        return [post(period === 'week' ? 1 : 2, 'Alice')];
      },
      tryCreatePublicationRequest: async ({ key }) => {
        events.push(`insert:${key}`);
        return key.includes(':week:') ? 101 : 102;
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' },
          { source: 'best', key: 'day', enabled: true, limit: 1, template: 'Best day' }
        ]
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
  assert.deepEqual(events, ['exists:publish:best:week:2026-06-29T00-00']);

  releaseFirst();
  const firstResult = await first.promise;
  const differentResult = await different.promise;

  assert.equal(firstResult.selections[0].status, 'scheduled');
  assert.equal(differentResult.selections[0].status, 'scheduled');
  assert.deepEqual(events, [
    'exists:publish:best:week:2026-06-29T00-00',
    'posts:week',
    'insert:publish:best:week:2026-06-29T00-00',
    'exists:publish:best:day:2026-06-29T00-00',
    'posts:day',
    'insert:publish:best:day:2026-06-29T00-00'
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

test('SelectionPublisher stops automatic retries when a started delivery has an uncertain outcome', async () => {
  let uncertain = null;
  let updated = false;
  const publisher = new SelectionPublisher({
    repository: {
      markPublicationHeaderSending: async () => {},
      markPublicationUncertain: async (publicationId, _ownerId, error) => {
        uncertain = { publicationId, error };
      },
      updatePublicationError: async () => { updated = true; },
      listPublicationPosts: async () => []
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: { ...config(), rateLimit: { telegramOperationTimeoutMs: 5 }, publish: { dryRun: false } }
  });
  publisher.bot.telegram = { sendMessage: async () => new Promise(() => {}) };

  await assert.rejects(() => publisher.processPublicationRequest(request({ id: 43, status: 'created' })), {
    code: 'TELEGRAM_OPERATION_TIMEOUT'
  });
  assert.equal(uncertain.publicationId, 43);
  assert.equal(uncertain.error.indeterminate, true);
  assert.equal(updated, false);
});

test('SelectionPublisher.runManualSync runs sync worker and replies with final stats', async () => {
  const replies = [];
  let finishSync;
  const syncResult = new Promise((resolve) => {
    finishSync = resolve;
  });
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      sync: async (source) => {
        assert.equal(source, 'admin');
        return {
          status: 'running',
          key: 'sync',
          promise: syncResult
        };
      }
    },
    config: config()
  });

  await publisher.runManualSync({
    from: { id: 1 },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(replies, ['Sync job status: running']);
  assert.equal(publisher.backgroundTasks.size, 1);

  finishSync({
    isInitial: false,
    since: '2026-06-27T16:00:00.000Z',
    pages: 2,
    fetched: 150,
    matched: 120,
    saved: 118,
    skippedOld: 2,
    deleted: 1,
    seen: 118,
    stopReason: 'reached-since-date'
  });
  await publisher.waitForIdle(100);

  assert.equal(replies.length, 2);
  assert.equal(replies[0], 'Sync job status: running');
  assert.match(replies[1], /Sync finished/);
  assert.match(replies[1], /since: 2026-06-27T16:00:00.000Z/);
  assert.match(replies[1], /pages: 2/);
  assert.match(replies[1], /fetched: 150/);
  assert.match(replies[1], /matched: 120/);
  assert.match(replies[1], /saved: 118/);
  assert.match(replies[1], /skipped old: 2/);
  assert.match(replies[1], /deleted: 1/);
  assert.match(replies[1], /stop reason: reached-since-date/);
});

test('SelectionPublisher.runManualBackfill replies with final stats after completion', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      backfill: async (days, source) => {
        assert.equal(days, 90);
        assert.equal(source, 'admin');
        return {
          status: 'running',
          key: 'backfill:90',
          promise: Promise.resolve({
            days: 90,
            since: '2026-04-05T16:00:00.000Z',
            updateSince: '2026-06-27T16:00:00.000Z',
            pages: 1,
            fetched: 100,
            matched: 92,
            added: 30,
            updated: 0,
            skippedExistingOld: 0,
            skippedOld: 62,
            deleted: 0,
            seen: 30,
            stopReason: 'reached-since-date'
          })
        };
      }
    },
    config: config()
  });

  await publisher.runManualBackfill({
    message: { text: '/backfill 90' },
    reply: async (message) => replies.push(message)
  });
  await publisher.waitForIdle(100);

  assert.equal(replies.length, 2);
  assert.equal(replies[0], 'Backfill job status: running');
  assert.match(replies[1], /Backfill finished/);
  assert.match(replies[1], /days: 90/);
  assert.match(replies[1], /since: 2026-04-05T16:00:00.000Z/);
  assert.match(replies[1], /fetched: 100/);
  assert.match(replies[1], /matched: 92/);
  assert.match(replies[1], /added: 30/);
  assert.match(replies[1], /updated: 0/);
  assert.match(replies[1], /skipped existing old: 0/);
  assert.match(replies[1], /skipped old: 62/);
  assert.match(replies[1], /deleted: 0/);
  assert.match(replies[1], /matched but not stored: 62/);
  assert.match(replies[1], /stop reason: reached-since-date/);
});

test('SelectionPublisher.runManualBackfill keeps busy response single-message', async () => {
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

test('SelectionPublisher.runManualSync reports final job failure', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      sync: async () => ({
        status: 'running',
        key: 'sync',
        promise: Promise.resolve({ failed: true, error: 'FLOOD_WAIT_12' })
      })
    },
    config: config()
  });

  await publisher.runManualSync({
    reply: async (message) => replies.push(message)
  });
  await publisher.waitForIdle(100);

  assert.deepEqual(replies, [
    'Sync job status: running',
    'Sync failed: FLOOD_WAIT_12'
  ]);
});

test('SelectionPublisher logs a failed background result reply without an unhandled rejection', async () => {
  const logs = [];
  let replyCount = 0;
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    syncWorker: {
      sync: async () => ({
        status: 'running',
        key: 'sync',
        promise: Promise.resolve({ pages: 1, fetched: 10, matched: 8, saved: 8 })
      })
    },
    config: config()
  });
  publisher.logger = {
    error: (message, fields) => logs.push({ message, fields })
  };

  await publisher.runManualSync({
    reply: async () => {
      replyCount += 1;
      if (replyCount > 1) throw new Error('reply unavailable');
    }
  });
  await publisher.waitForIdle(100);

  assert.equal(replyCount, 2);
  assert.equal(publisher.backgroundTasks.size, 0);
  assert.deepEqual(logs, [{
    message: 'Failed to send manual job result',
    fields: { operation: 'sync', jobKey: 'sync', error: 'reply unavailable' }
  }]);
});

test('SelectionPublisher.runManualPublish plans selections and replies with job status', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async () => 123,
      getNextPublicationRequest: async () => null
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' }
        ]
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
      getPublicationByKey: async () => ({
        id: 10,
        status: 'published',
        get data() {
          throw new Error('duplicate path must not read publication data count');
        }
      }),
      getSelectionPosts: async () => {
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
        template: [
          { source: 'best', key: 'day', enabled: true, limit: 5, template: 'Best day' }
        ]
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

test('SelectionPublisher.runManualPublish skips selections before firstSendAt unless forced', async () => {
  const replies = [];
  let postQueries = 0;
  let insertAttempts = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => {
        throw new Error('firstSendAt skip must happen before duplicate lookup');
      },
      getSelectionPosts: async () => {
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
        template: [
          {
            source: 'best',
            key: 'day',
            enabled: true,
            limit: 5,
            firstSendAt: '2999-06-30T00:00:00.000Z',
            template: 'Best day'
          }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish day' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(postQueries, 0);
  assert.equal(insertAttempts, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /best\.day: skipped until firstSendAt 2999-06-30T00:00:00\.000Z\. Use -force to publish earlier\./);
  assert.match(replies[0], /No new publication request was created\. Worker was not started\./);
});

test('SelectionPublisher.runManualPublish force bypasses firstSendAt', async () => {
  const replies = [];
  let postQueries = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => {
        throw new Error('forced publish must not check canonical duplicate');
      },
      getSelectionPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => 123,
      getNextPublicationRequest: async () => null
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          {
            source: 'best',
            key: 'day',
            enabled: true,
            limit: 5,
            firstSendAt: '2999-06-30T00:00:00.000Z',
            template: 'Best day'
          }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish day -force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(postQueries, 1);
  assert.match(replies[0], /best\.day: publication request created \(1 posts\) forced/);
});

test('SelectionPublisher.runManualPublish uses later global firstSendAt', async () => {
  const replies = [];
  let postQueries = 0;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => {
        throw new Error('firstSendAt skip must happen before duplicate lookup');
      },
      getSelectionPosts: async () => {
        postQueries += 1;
        return [post(1, 'Alice')];
      },
      tryCreatePublicationRequest: async () => 123
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      ...config(),
      publish: {
        dryRun: false,
        firstSendAt: '2999-10-01T00:00:00.000Z',
        template: [
          {
            source: 'best',
            key: 'day',
            enabled: true,
            limit: 5,
            firstSendAt: '2026-01-01T00:00:00.000Z',
            template: 'Best day'
          }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish day' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(postQueries, 0);
  assert.match(replies[0], /best\.day: skipped until firstSendAt 2999-10-01T00:00:00\.000Z/);
});

test('SelectionPublisher.runManualPublish does not create publication request when period has no posts', async () => {
  const replies = [];
  let insertAttempted = false;
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => [],
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
        template: [
          { source: 'best', key: 'day', enabled: true, limit: 5, template: 'Best day' }
        ]
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
      getSelectionPosts: async (spec) => {
        if (spec.source === 'controversial') {
          controversialSpecs.push(spec.key);
          return [post(10 + controversialSpecs.length, 'Bob')];
        }
        topSpecs.push(spec.key);
        return [post(topSpecs.length, 'Alice')];
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
        template: [
          { source: 'best', key: 'month', enabled: true, limit: 1, template: 'Best month' },
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' },
          { source: 'best', key: 'day', enabled: true, limit: 1, template: 'Best day' },
          { source: 'controversial', key: 'month', enabled: true, limit: 1, threshold: 0.3, template: 'Controversial month' },
          { source: 'controversial', key: 'week', enabled: true, limit: 1, threshold: 0.3, template: 'Controversial week' },
          { source: 'controversial', key: 'day', enabled: true, limit: 1, threshold: 0.3, template: 'Controversial day' }
        ]
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
      getSelectionPosts: async (spec) => {
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
        template: [
          { source: 'controversial', key: 'week', enabled: false, limit: 1, threshold: 0.3, template: 'Controversial week' }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish controversial.week -force' },
    reply: async (message) => replies.push(message)
  });

  assert.deepEqual(queried, ['controversial.week']);
  assert.equal(insertedKeys.length, 1);
  assert.match(insertedKeys[0], /^publish:force:[a-z0-9]{6}:controversial:week:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
  assert.match(replies[0], /controversial\.week: publication request created \(1 posts\) forced/);
});

test('SelectionPublisher.runManualPublish explains when worker is already running', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => [post(1, 'Alice')],
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
        template: [
          { source: 'controversial', key: 'day', enabled: false, limit: 3, threshold: 0.3, template: 'Controversial day' }
        ]
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

test('SelectionPublisher.runManualPublish explains when follow-up worker is queued', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => [post(1, 'Alice')],
      tryCreatePublicationRequest: async () => 123
    },
    mediaDownloader: {},
    setupAssistant: null,
    jobGate: {
      run: () => ({
        status: 'scheduled',
        key: 'publish-worker',
        promise: Promise.resolve({ queued: true })
      })
    },
    config: {
      ...config(),
      publish: {
        dryRun: false,
        template: [
          { source: 'controversial', key: 'day', enabled: false, limit: 3, threshold: 0.3, template: 'Controversial day' }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish controversial.day -force' },
    reply: async (message) => replies.push(message)
  });

  assert.match(replies[0], /A follow-up worker run was queued/);
  assert.doesNotMatch(replies[0], /Worker job status: scheduled/);
});

test('SelectionPublisher.runManualPublish does not schedule disabled selection without force', async () => {
  const replies = [];
  let queried = false;
  const publisher = new SelectionPublisher({
    repository: {
      getSelectionPosts: async () => {
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
        template: [
          { source: 'controversial', key: 'week', enabled: false, limit: 1, threshold: 0.3, template: 'Controversial week' }
        ]
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
      getSelectionPosts: async () => {
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
      getSelectionPosts: async () => [post(1, 'Alice')],
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
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish best.week --force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(keys.length, 1);
  assert.match(keys[0], /^publish:force:[a-z0-9]{6}:best:week:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
  assert.match(replies[0], /best\.week: publication request created \(1 posts\) forced/);
});

test('SelectionPublisher.runManualPublish supports single-dash force scheduling', async () => {
  const keys = [];
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      getPublicationByKey: async () => null,
      getSelectionPosts: async () => [post(1, 'Alice')],
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
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 1, template: 'Best week' }
        ]
      }
    }
  });

  await publisher.runManualPublish({
    message: { text: '/publish best.week -force' },
    reply: async (message) => replies.push(message)
  });

  assert.equal(keys.length, 1);
  assert.match(keys[0], /^publish:force:[a-z0-9]{6}:best:week:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
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
            selectionKey: 'best.day_[x]',
            sentCount: 0,
            expectedCount: 5,
            updatedAt: '2026-06-29T11:00:00.000Z',
            lastError: 'network <failed> & retry'
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
  assert.match(replies[0].message, /best\.day_\[x\]/);
  assert.match(replies[0].message, /network &lt;failed&gt; &amp; retry/);
  assert.deepEqual(replies[0].options, { parse_mode: 'HTML' });
});

test('SelectionPublisher.replyPublications returns recent publications table', async () => {
  const replies = [];
  const publisher = new SelectionPublisher({
    repository: {
      listRecentPublications: async (options) => {
        assert.deepEqual(options, { limit: 10 });
        return [{
          id: 7,
          key: 'publish:best:week_[x]:2026-06-29T00-00<bad>&',
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
  assert.match(replies[0].message, /publish:best:week_\[x\]:2026-06-29T00-00&lt;bad&gt;&amp;/);
  assert.match(replies[0].message, /10\/10/);
  assert.doesNotMatch(replies[0].message, /updated/i);
  assert.doesNotMatch(replies[0].message, /\bselection\b/i);
  assert.doesNotMatch(replies[0].message, /\btitle\b/i);
  assert.deepEqual(replies[0].options, { parse_mode: 'HTML' });
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
          selectionKey: 'best.week_[x]',
          title: 'Best _week_ <bad> & ok',
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T11:00:00.000Z',
          finishedAt: '2026-06-29T12:00:00.000Z',
          lastError: 'telegram <failed> & retry _later_'
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
          author: 'Alice_[x] <bad>'
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
  assert.match(replies[0].message, /Selection: best\.week_\[x\]/);
  assert.match(replies[0].message, /Title: Best _week_ &lt;bad&gt; &amp; ok/);
  assert.match(replies[0].message, /Last error: telegram &lt;failed&gt; &amp; retry _later_/);
  assert.match(replies[0].message, /Created: 2026-06-29 10:00:00Z/);
  assert.match(replies[0].message, /Finished: 2026-06-29 12:00:00Z/);
  assert.doesNotMatch(replies[0].message, /Updated:/);
  assert.match(replies[0].message, /123/);
  assert.match(replies[0].message, /Alice_\[x\] &lt;bad&gt;/);
  assert.deepEqual(replies[0].options, { parse_mode: 'HTML' });
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
    key: 'publish:best:week:2026-06-29T00-00',
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
