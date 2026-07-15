import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, deepMerge, migrateOldPublishSelections, validateConfig } from '../src/config/index.js';

test('deepMerge preserves object defaults and replaces user-defined publish templates', () => {
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
        { source: 'best', key: 'week', limit: 20 },
        { source: 'custom', key: 'night', enabled: false, limit: 3 }
      ]
    }
  });
});

test('deepMerge keeps default publish templates when user config omits templates', () => {
  const result = deepMerge(
    {
      publish: {
        dryRun: false,
        workerIntervalMinutes: 10,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 10 },
          { source: 'best', key: 'day', enabled: true, limit: 5 }
        ]
      }
    },
    {
      publish: {
        dryRun: true
      }
    }
  );

  assert.deepEqual(result, {
    publish: {
      dryRun: true,
      workerIntervalMinutes: 10,
      template: [
        { source: 'best', key: 'week', enabled: true, limit: 10 },
        { source: 'best', key: 'day', enabled: true, limit: 5 }
      ]
    }
  });
});

test('deepMerge allows user config to clear default publish templates', () => {
  const result = deepMerge(
    {
      publish: {
        dryRun: false,
        template: [
          { source: 'best', key: 'week', enabled: true, limit: 10 }
        ]
      }
    },
    {
      publish: {
        template: []
      }
    }
  );

  assert.deepEqual(result, {
    publish: {
      dryRun: false,
      template: []
    }
  });
});

test('deepMerge still merges publish sources by key', () => {
  const result = deepMerge(
    {
      publish: {
        sources: [
          { key: 'best', where: 'true' },
          { key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.3' }
        ]
      }
    },
    {
      publish: {
        sources: [
          { key: 'best', where: 'likes > 0' },
          { key: 'positive', where: 'likes > dislikes' }
        ]
      }
    }
  );

  assert.deepEqual(result, {
    publish: {
      sources: [
        { key: 'best', where: 'likes > 0' },
        { key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.3' },
        { key: 'positive', where: 'likes > dislikes' }
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

test('applyEnv configures Redis connection but keeps namespace and group in config files', () => {
  const config = applyEnv({
    rateLimit: { redis: { enabled: false, url: 'redis://127.0.0.1:6379' } }
  }, {
    RATE_LIMIT_REDIS_ENABLED: 'true',
    RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379/2'
  });

  assert.equal(config.rateLimit.redis.enabled, true);
  assert.equal(config.rateLimit.redis.url, 'redis://redis.internal:6379/2');
  assert.equal(config.rateLimit.redis.keyPrefix, undefined);
  assert.equal(config.rateLimit.mtprotoGroup, undefined);
});

test('validateConfig requires explicit Redis namespace and MTProto group', () => {
  const config = validConfig();
  config.rateLimit = {
    mtprotoGroup: 'local',
    maxQueueDelayMs: 300000,
    longWaitWarnMs: 10000,
    redis: {
      enabled: true,
      mode: 'standalone',
      keyPrefix: 'tg-memes:local',
      fallbackMultiplier: 3
    }
  };
  assert.throws(() => validateConfig(config), /mtprotoGroup must be set explicitly/);

  config.rateLimit.mtprotoGroup = 'main-account';
  assert.throws(() => validateConfig(config), /keyPrefix must be set explicitly/);

  config.rateLimit.redis.keyPrefix = 'tg-memes:production';
  config.telegram.botToken = '123456:token';
  assert.doesNotThrow(() => validateConfig(config));
});

test('validateConfig requires a positive shutdown deadline', () => {
  const config = validConfig();
  config.shutdown = { timeoutMs: 0 };
  assert.throws(() => validateConfig(config), /shutdown\.timeoutMs must be positive/);
  config.shutdown.timeoutMs = 30_000;
  assert.doesNotThrow(() => validateConfig(config));
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
        firstSendAt: 'not-a-date',
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
        firstSendAt: 'not-a-date',
        template: [
          {
            source: 'custom',
            key: 'bad',
            enabled: true,
            schedule: { type: 'monthly', dayOfMonth: 31, time: '25:00' },
            windowHours: 0,
            firstSendAt: 'not-a-date',
            posts: { min: 5, target: 3, max: 4 },
            reactions: { strategy: 'median', min: 0, includeAbove: 10 }
          }
        ]
      }
    }),
    /publish\.firstSendAt: expected valid date string[\s\S]*publish\.template\.0\.source: unknown publish source[\s\S]*publish\.template\.0\.windowHours: expected number greater than 0[\s\S]*publish\.template\.0\.posts: expected min <= target <= max[\s\S]*publish\.template\.0\.reactions\.strategy: expected likes, dislikes, sum, or max[\s\S]*publish\.template\.0\.schedule\.time: expected HH:mm[\s\S]*publish\.template\.0\.schedule\.dayOfMonth: expected integer from 1 to 28[\s\S]*publish\.template\.0\.firstSendAt: expected valid date string/
  );
});


test('validateConfig accepts a user-defined template set without default template keys', () => {
  assert.doesNotThrow(() => validateConfig({
    ...validConfig(),
    publish: {
      ...validConfig().publish,
      template: [
        template('daily_morning_best', 'best', { type: 'daily', time: '11:00' }, 12, 'Morning {{count}}'),
        template('daily_night_best', 'best', { type: 'daily', time: '23:00' }, 12, 'Night {{count}}')
      ]
    }
  }));
});

test('validateConfig accepts non-negative publish template offsetHours', () => {
  assert.doesNotThrow(() => validateConfig({
    ...validConfig(),
    publish: {
      ...validConfig().publish,
      template: [
        {
          ...template('daily_best', 'best', { type: 'daily', time: '10:00' }, 24, 'Day {{count}}'),
          offsetHours: 168
        },
        {
          ...template('weekly_best', 'best', { type: 'weekly', weekday: 1, time: '10:00' }, 168, 'Week {{count}}'),
          offsetHours: 0.5
        }
      ]
    }
  }));
});

test('validateConfig rejects invalid publish template offsetHours', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig(),
      publish: {
        ...validConfig().publish,
        template: [
          {
            ...template('daily_best', 'best', { type: 'daily', time: '10:00' }, 24, 'Day {{count}}'),
            offsetHours: -1
          },
          {
            ...template('weekly_best', 'best', { type: 'weekly', weekday: 1, time: '10:00' }, 168, 'Week {{count}}'),
            offsetHours: Number.NaN
          },
          {
            ...template('monthly_best', 'best', { type: 'monthly', dayOfMonth: 1, time: '10:00' }, 720, 'Month {{count}}'),
            offsetHours: '168'
          }
        ]
      }
    }),
    /publish\.template\.1\.offsetHours: expected number, got number[\s\S]*publish\.template\.2\.offsetHours: expected number, got string/
  );

  assert.throws(
    () => validateConfig({
      ...validConfig(),
      publish: {
        ...validConfig().publish,
        template: [
          {
            ...template('daily_best', 'best', { type: 'daily', time: '10:00' }, 24, 'Day {{count}}'),
            offsetHours: -1
          }
        ]
      }
    }),
    /publish\.template\.0\.offsetHours: expected number greater than or equal to 0/
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

test('validateConfig rejects invalid semantic ranges, timezone, and parser locale', () => {
  const config = validConfig();
  config.sync.intervalHours = 0;
  config.sync.pageSize = 0;
  config.sync.maxMissingRatio = 1.2;
  config.schedule.timezone = 'Not/A_Timezone';
  config.parsing.countLocale = 'invalid_locale_@@';
  config.publish.postMaxRetries = -1;
  config.publish.maxConsecutivePostFailures = 1.5;
  config.templates.publish.maxTextLength = 5000;

  assert.throws(() => validateConfig(config), (error) => {
    assert.match(error.message, /sync\.intervalHours/);
    assert.match(error.message, /sync\.pageSize/);
    assert.match(error.message, /sync\.maxMissingRatio/);
    assert.match(error.message, /schedule\.timezone/);
    assert.match(error.message, /parsing\.countLocale/);
    assert.match(error.message, /publish\.postMaxRetries/);
    assert.match(error.message, /publish\.maxConsecutivePostFailures/);
    assert.match(error.message, /templates\.publish\.maxTextLength/);
    return true;
  });
});

test('validateConfig accepts explicit fallback markers and a supported number locale', () => {
  const config = validConfig();
  config.parsing.countLocale = 'de-DE';
  config.parsing.fallbackReactions = {
    likeMarkers: ['+', '👍'],
    dislikeMarkers: ['-', '👎']
  };
  config.sync.maxMissingRatio = 0.3;
  config.sync.maxRetries = 3;
  config.sync.retryBaseMs = 100;
  config.sync.retryMaxMs = 1000;
  config.sync.mediaMaxBytes = 1024;
  config.sync.mediaMaxAgeHours = 1;
  config.publish.postMaxRetries = 3;
  config.publish.maxConsecutivePostFailures = 3;
  config.publish.requestMaxRetries = 3;
  config.publish.retryBaseMs = 100;
  config.publish.retryMaxMs = 1000;

  assert.doesNotThrow(() => validateConfig(config));
});

test('applyEnv maps Redis required mode explicitly', () => {
  const config = applyEnv({
    rateLimit: { redis: { enabled: false, required: false } }
  }, {
    RATE_LIMIT_REDIS_ENABLED: 'true',
    RATE_LIMIT_REDIS_REQUIRED: 'true'
  });

  assert.equal(config.rateLimit.redis.enabled, true);
  assert.equal(config.rateLimit.redis.required, true);
});

test('validateConfig rejects required Redis mode while Redis is disabled', () => {
  const config = validConfig();
  config.rateLimit = {
    maxQueueDelayMs: 300_000,
    longWaitWarnMs: 10_000,
    telegramOperationTimeoutMs: 60_000,
    redis: { enabled: false, required: true }
  };

  assert.throws(
    () => validateConfig(config),
    /required cannot be true when Redis rate limiting is disabled/
  );
});
