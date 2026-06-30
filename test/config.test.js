import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, deepMerge, validateConfig } from '../src/config/index.js';

test('deepMerge preserves defaults and overrides nested values', () => {
  const result = deepMerge(
    {
      telegram: { apiId: 1, apiHash: 'default' },
      publish: { dryRun: false, selections: { best: { week: { limit: 10 } } } }
    },
    {
      telegram: { apiHash: 'custom' },
      publish: { dryRun: true }
    }
  );

  assert.deepEqual(result, {
    telegram: { apiId: 1, apiHash: 'custom' },
    publish: { dryRun: true, selections: { best: { week: { limit: 10 } } } }
  });
});

test('applyEnv maps secrets and telegram ids from environment', () => {
  const result = applyEnv(
    {
      telegram: { sessionFile: 'sessions/user.session' },
      sync: { refreshRecentDays: 7 }
    },
    {
      TELEGRAM_API_ID: '123',
      TELEGRAM_API_HASH: 'hash',
      TELEGRAM_SOURCE_CHAT_ID: '-1001',
      TELEGRAM_ADMIN_ID: '99',
      TELEGRAM_PUBLISH_CHANNEL_ID: '-1002',
      TELEGRAM_BOT_TOKEN: 'token'
    }
  );

  assert.deepEqual(result.telegram, {
    sessionFile: 'sessions/user.session',
    apiId: 123,
    apiHash: 'hash',
    sourceChatId: -1001,
    adminId: 99,
    publishChannelId: -1002,
    botToken: 'token'
  });
});

test('validateConfig rejects identical source and publish chats', () => {
  assert.throws(
    () => validateConfig({
      telegram: {
        apiId: 123,
        apiHash: 'hash',
        sessionFile: 'sessions/user.session',
        sourceChatId: -1001,
        adminId: 99,
        publishChannelId: -1001,
        botToken: 'token'
      },
      database: { path: 'data/posts.sqlite' }
    }),
    /sourceChatId and telegram\.publishChannelId must be different/
  );
});

test('validateConfig rejects all schema issues at once', () => {
  let error;
  try {
    validateConfig({
      ...validConfig(),
      unknown: true,
      sync: {
        ...validConfig().sync,
        initialSync: false
      },
      logging: {
        ...validConfig().logging,
        level: 'info',
        logLevel: 10
      },
      schedule: {
        ...validConfig().schedule,
        runOnStart: false,
        syncIntervalHours: 24,
        enabled: 'yes'
      },
      parsing: {
        ...validConfig().parsing,
        filters: 'bad',
        likes: [{ source: 'message', transform: 'count', group: '1', typo: true }]
      },
      publish: {
        ...validConfig().publish,
        selections: {
          ...validConfig().publish.selections,
          best: {
            ...validConfig().publish.selections.best,
            week: {
              ...validConfig().publish.selections.best.week,
              limit: '10'
            }
          }
        }
      }
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(error.message, /Invalid config:/);
  assert.match(error.message, /- unknown: unsupported option/);
  assert.match(error.message, /- sync\.initialSync: unsupported option/);
  assert.match(error.message, /- logging\.logLevel: expected string, got number/);
  assert.match(error.message, /- logging\.level: unsupported option/);
  assert.match(error.message, /- schedule\.runOnStart: unsupported option/);
  assert.match(error.message, /- schedule\.syncIntervalHours: unsupported option/);
  assert.match(error.message, /- schedule\.enabled: expected boolean, got string/);
  assert.match(error.message, /- parsing\.filters: expected array, got string/);
  assert.match(error.message, /- parsing\.likes\.0\.group: expected number, got string/);
  assert.match(error.message, /- parsing\.likes\.0\.typo: unsupported option/);
  assert.match(error.message, /- publish\.selections\.best\.week\.limit: expected number, got string/);
});

function validConfig() {
  return {
    telegram: {
      apiId: 123,
      apiHash: 'hash',
      sessionFile: 'sessions/user.session',
      sourceChatId: -1001,
      adminId: 99,
      publishChannelId: -1002,
      botToken: 'token'
    },
    database: { path: 'data/posts.sqlite' },
    logging: { logLevel: 'silent' },
    sync: {
      initialScanDays: 60,
      refreshRecentDays: 7,
      pageSize: 100,
      mediaDir: 'tmp/media',
      intervalHours: 24,
      runOnStart: true,
      throttle: {
        enabled: true,
        historyMinMs: 800,
        historyMaxMs: 1800,
        mediaMinMs: 300,
        mediaMaxMs: 900
      }
    },
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      author: [],
      likes: [],
      dislikes: []
    },
    publish: {
      dryRun: true,
      requestTtlHours: 12,
      workerIntervalMinutes: 1,
      selections: {
        best: {
          month: { enabled: true, time: '10:20', limit: 10, template: 'Month {{count}}' },
          week: { enabled: true, time: '10:10', limit: 10, template: 'Week {{count}}' },
          day: { enabled: true, time: '10:00', limit: 5, windowHours: 24, template: 'Day {{count}}' }
        },
        controversial: {
          month: { enabled: false, time: '11:20', limit: 10, threshold: 0.3, template: 'Month {{count}}' },
          week: { enabled: false, time: '11:10', limit: 10, threshold: 0.3, template: 'Week {{count}}' },
          day: { enabled: false, time: '11:00', limit: 5, windowHours: 24, threshold: 0.3, template: 'Day {{count}}' }
        }
      }
    },
    templates: {
      publish: {
        postCaption: '{{position}}',
        unknownAuthor: 'unknown',
        maxTextLength: 700
      },
      stats: {
        summary: 'Stats',
        topPost: 'Top'
      }
    },
    schedule: {
      enabled: true,
      timezone: 'Europe/Moscow'
    }
  };
}
