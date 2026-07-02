import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, deepMerge, migrateOldPublishSelections, validateConfig } from '../src/config/index.js';

test('deepMerge preserves defaults and overrides nested values', () => {
  const result = deepMerge(
    {
      telegram: { apiId: 1, apiHash: 'default' },
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 10 },
          { source: 'best', key: 'day', enabled: true, limit: 5 }
        ]
      }
    },
    {
      telegram: { apiHash: 'custom' },
      publish: {
        dryRun: true,
        template: [
          { source: 'best', key: 'week', limit: 20 },
          { source: 'custom', key: 'night', enabled: false, limit: 3 }
        ]
      }
    }
  );

  assert.deepEqual(result, {
    telegram: { apiId: 1, apiHash: 'custom' },
    publish: {
      dryRun: true,
      template: [
        { source: 'best', key: 'week', enabled: true, limit: 20 },
        { source: 'best', key: 'day', enabled: true, limit: 5 },
        { source: 'custom', key: 'night', enabled: false, limit: 3 }
      ]
    }
  });
});

test('migrateOldPublishSelections converts nested selections to publish templates', () => {
  const migrated = migrateOldPublishSelections({
    publish: {
      dryRun: false,
      selections: {
        best: {
          week: { enabled: true, time: '10:10', limit: 10, template: 'Best week' }
        },
        controversial: {
          day: { enabled: false, time: '11:00', limit: 5, threshold: 0.3 }
        }
      }
    }
  });

  assert.deepEqual(migrated, {
    publish: {
      dryRun: false,
      template: [
        { source: 'best', key: 'week', enabled: true, time: '10:10', limit: 10, template: 'Best week' },
        { source: 'controversial', key: 'day', enabled: false, time: '11:00', limit: 5, threshold: 0.3 }
      ]
    }
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
        initialSync: false,
        retentionDays: '60',
        retentionInitialDelayMinutes: '15',
        retentionIntervalHours: '24'
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
        selections: { best: { week: { limit: 10 } } },
        template: [
          ...validConfig().publish.template,
          {
            source: 'best',
            key: 'custom',
            posts: { max: '10' }
          }
        ]
      }
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(error.message, /Invalid config:/);
  assert.match(error.message, /- unknown: unsupported option/);
  assert.match(error.message, /- sync\.initialSync: unsupported option/);
  assert.match(error.message, /- sync\.retentionDays: expected number, got string/);
  assert.match(error.message, /- sync\.retentionInitialDelayMinutes: expected number, got string/);
  assert.match(error.message, /- sync\.retentionIntervalHours: expected number, got string/);
  assert.match(error.message, /- logging\.logLevel: expected string, got number/);
  assert.match(error.message, /- logging\.level: unsupported option/);
  assert.match(error.message, /- schedule\.runOnStart: unsupported option/);
  assert.match(error.message, /- schedule\.syncIntervalHours: unsupported option/);
  assert.match(error.message, /- schedule\.enabled: expected boolean, got string/);
  assert.match(error.message, /- parsing\.filters: expected array, got string/);
  assert.match(error.message, /- parsing\.likes\.0\.group: expected number, got string/);
  assert.match(error.message, /- parsing\.likes\.0\.typo: unsupported option/);
  assert.match(error.message, /- publish\.selections: unsupported option/);
  assert.match(error.message, /- publish\.template\.6\.posts\.max: expected number, got string/);
});

test('validateConfig rejects duplicate publish template keys globally', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig(),
      publish: {
        ...validConfig().publish,
        template: [
          ...validConfig().publish.template,
          {
            source: 'controversial',
            key: 'weekly_best',
            enabled: true,
            schedule: { type: 'daily', time: '12:00' },
            windowHours: 24,
            posts: { min: 1, target: 1, max: 3 },
            reactions: { strategy: 'sum', min: 0, includeAbove: 999 }
          }
        ]
      }
    }),
    /Duplicate publish templates:\n- weekly_best \(2\)/
  );
});

test('validateConfig rejects invalid publish template settings', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig(),
      publish: {
        ...validConfig().publish,
        template: [
          {
            source: 'custom',
            key: 'bad',
            enabled: true,
            schedule: { type: 'monthly', dayOfMonth: 31, time: '25:00' },
            windowHours: 0,
            posts: { min: 5, target: 3, max: 4 },
            reactions: { strategy: 'median', min: 0, includeAbove: 10 }
          }
        ]
      }
    }),
    /publish\.template\.0\.source: unknown publish source[\s\S]*publish\.template\.0\.windowHours: expected number greater than 0[\s\S]*publish\.template\.0\.posts: expected min <= target <= max[\s\S]*publish\.template\.0\.reactions\.strategy: expected likes, dislikes, sum, or max[\s\S]*publish\.template\.0\.schedule\.time: expected HH:mm[\s\S]*publish\.template\.0\.schedule\.dayOfMonth: expected integer from 1 to 28/
  );
});

test('validateConfig allows custom publish sources and rejects unsafe source expressions', () => {
  const withCustomSource = {
    ...validConfig(),
    publish: {
      ...validConfig().publish,
      sources: [
        { key: 'positive', where: 'likes > dislikes and abs(likes - dislikes) >= 3' }
      ],
      template: [
        template('positive_daily', 'positive', { type: 'daily', time: '12:00' }, 24, 'Positive {{count}}')
      ]
    }
  };

  assert.doesNotThrow(() => validateConfig(withCustomSource));
  assert.throws(
    () => validateConfig({
      ...validConfig(),
      publish: {
        ...validConfig().publish,
        sources: [
          { key: 'unsafe', where: 'json_extract(data, "$.x") = 1' }
        ],
        template: [
          template('unsafe_daily', 'unsafe', { type: 'daily', time: '12:00' }, 24, 'Unsafe {{count}}')
        ]
      }
    }),
    /publish\.sources\.0\.where: invalid expression/
  );
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
    logging: { logLevel: 'silent', color: 'never' },
    sync: {
      initialScanDays: 60,
      refreshRecentDays: 7,
      pageSize: 100,
      mediaDir: 'tmp/media',
      intervalHours: 24,
      runOnStart: true,
      retentionDays: 60,
      retentionInitialDelayMinutes: 15,
      retentionIntervalHours: 24,
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
      workerIntervalMinutes: 10,
      template: [
        template('monthly_best', 'best', { type: 'monthly', dayOfMonth: 1, time: '10:20' }, 720, 'Month {{count}}'),
        template('weekly_best', 'best', { type: 'weekly', weekday: 1, time: '10:10' }, 168, 'Week {{count}}'),
        template('daily_best', 'best', { type: 'daily', time: '10:00' }, 24, 'Day {{count}}'),
        template('monthly_controversial', 'controversial', { type: 'monthly', dayOfMonth: 1, time: '11:20' }, 720, 'Month {{count}}', false, 'sum'),
        template('weekly_controversial', 'controversial', { type: 'weekly', weekday: 1, time: '11:10' }, 168, 'Week {{count}}', false, 'sum'),
        template('daily_controversial', 'controversial', { type: 'daily', time: '11:00' }, 24, 'Day {{count}}', false, 'sum')
      ]
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

function template(key, source, schedule, windowHours, header, enabled = true, strategy = 'likes') {
  return {
    source,
    key,
    enabled,
    schedule,
    windowHours,
    posts: { min: 1, target: 5, max: 10 },
    reactions: { strategy, min: 0, includeAbove: 999999 },
    template: header
  };
}
