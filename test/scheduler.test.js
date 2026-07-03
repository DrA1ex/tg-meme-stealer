import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLogger } from '../src/core/logger.js';
import {
  Scheduler,
  getDelayUntilLocalTime,
  getNextLocalTimeAsDate,
  getNextEligibleScheduledRunAsDate,
  getNextScheduledRunAsDate,
  getPreviousScheduledRunAsDate
} from '../src/runtime/scheduler.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('Scheduler.start does not wait for startup sync before returning', async () => {
  let syncStarted = false;
  let syncScheduled = false;
  let publicationsScheduled = false;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      sync: { runOnStart: true, intervalHours: 24 },
      publish: { template: [] },
      logging: { logLevel: 'silent' }
    },
    {
      sync: () => {
        syncStarted = true;
        return new Promise(() => {});
      },
      publish: async () => {},
      publishWorker: async () => {}
    }
  );
  scheduler.scheduleSync = () => {
    syncScheduled = true;
  };
  scheduler.schedulePublications = () => {
    publicationsScheduled = true;
  };
  scheduler.schedulePublicationWorker = () => {};

  await scheduler.start();

  assert.equal(syncScheduled, true);
  assert.equal(publicationsScheduled, true);
  assert.equal(syncStarted, true);
});

test('Scheduler skips timer sync while startup sync is still running', async () => {
  let syncRuns = 0;
  const scheduledCallbacks = [];
  let resolveStartupSync;
  const startupSyncDone = new Promise((resolve) => {
    resolveStartupSync = resolve;
  });
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      sync: { runOnStart: true, intervalHours: 24 },
      publish: { template: [] },
      logging: { logLevel: 'silent' }
    },
    {
      sync: () => {
        syncRuns += 1;
        if (syncRuns === 1) {
          return {
            status: 'running',
            promise: startupSyncDone
          };
        }
        return {
          status: 'skipped',
          reason: 'duplicate_job',
          promise: Promise.resolve({ skipped: true })
        };
      },
      publish: async () => {},
      publishWorker: async () => {}
    }
  );
  scheduler.schedulePublicationWorker = () => {};
  scheduler.scheduleTimeout = (fn) => {
    scheduledCallbacks.push(fn);
    return { fake: true };
  };

  await scheduler.start();
  assert.equal(syncRuns, 1);
  assert.equal(scheduledCallbacks.length, 1);

  await scheduledCallbacks[0]();

  assert.equal(syncRuns, 2);
  assert.equal(scheduledCallbacks.length, 2);
  resolveStartupSync();
});

test('Scheduler runs retention after initial delay and then schedules interval', async () => {
  const delays = [];
  let retentionRuns = 0;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      sync: {
        runOnStart: false,
        intervalHours: 24,
        retentionInitialDelayMinutes: 15,
        retentionIntervalHours: 24
      },
      publish: { template: [] },
      logging: { logLevel: 'silent' }
    },
    {
      sync: async () => {},
      publish: async () => {},
      publishWorker: async () => {},
      retention: async () => {
        retentionRuns += 1;
      }
    }
  );
  scheduler.scheduleSync = () => {};
  scheduler.schedulePublicationWorker = () => {};
  scheduler.schedulePublications = () => {};
  scheduler.planMissedPublications = async () => {};
  scheduler.scheduleTimeout = (fn, delayMs) => {
    delays.push({ fn, delayMs });
    return { fake: true };
  };

  await scheduler.start();

  assert.equal(delays.length, 1);
  assert.equal(delays[0].delayMs, 15 * 60 * 1000);

  await delays[0].fn();

  assert.equal(retentionRuns, 1);
  assert.equal(delays.length, 2);
  assert.equal(delays[1].delayMs, 24 * 60 * 60 * 1000);
});

test('Scheduler wakes publication worker on startup but not on interval reschedule', async () => {
  const delays = [];
  const events = [];
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      sync: { runOnStart: false, intervalHours: 24 },
      publish: {
        workerIntervalMinutes: 10,
        template: []
      },
      logging: { logLevel: 'silent' }
    },
    {
      sync: async () => {},
      publish: async () => {},
      publishWorker: async () => {
        events.push('worker');
      }
    }
  );
  scheduler.scheduleSync = () => {};
  scheduler.scheduleRetention = () => {};
  scheduler.schedulePublications = () => {};
  scheduler.planMissedPublications = async () => {};
  scheduler.scheduleTimeout = (fn, delayMs) => {
    delays.push({ fn, delayMs });
    return { fake: true };
  };

  await scheduler.start();

  assert.deepEqual(events, ['worker']);
  assert.equal(delays.length, 1);
  assert.equal(delays[0].delayMs, 10 * 60 * 1000);

  await delays[0].fn();

  assert.deepEqual(events, ['worker', 'worker']);
  assert.equal(delays.length, 2);
  assert.equal(delays[1].delayMs, 10 * 60 * 1000);
});

test('Scheduler publishes with intended scheduled time instead of callback time', async () => {
  const published = [];
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'UTC'
      },
      sync: {
        runOnStart: false,
        intervalHours: 24
      },
      publish: {
        template: [
          { source: 'best', key: 'daily_best', enabled: true, schedule: { type: 'daily', time: '10:00' } }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async (key, scheduledAt) => published.push({ key, scheduledAt: scheduledAt.toISOString() }),
      publishWorker: async () => {}
    }
  );
  scheduler.scheduleTimeout = (fn) => {
    if (!scheduler.scheduledCallback) scheduler.scheduledCallback = fn;
    return { fake: true };
  };

  scheduler.schedulePublication('best.daily_best', { type: 'daily', time: '10:00' }, new Date('2026-06-29T09:59:00.000Z'));
  await scheduler.scheduledCallback();

  assert.deepEqual(published, [{
    key: 'best.daily_best',
    scheduledAt: '2026-06-29T10:00:00.000Z'
  }]);
});

test('Scheduler delays publication timers until firstSendAt eligible run', async () => {
  const scheduled = [];
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'UTC'
      },
      sync: {
        runOnStart: false,
        intervalHours: 24
      },
      publish: {
        firstSendAt: '2026-07-03T00:00:00.000Z',
        template: [
          {
            source: 'best',
            key: 'daily_best',
            enabled: true,
            schedule: { type: 'daily', time: '10:00' },
            firstSendAt: '2026-07-02T00:00:00.000Z'
          }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async () => {},
      publishWorker: async () => {}
    }
  );
  scheduler.scheduleTimeout = (fn, delayMs) => {
    scheduled.push({ fn, delayMs });
    return { fake: true };
  };

  scheduler.schedulePublications(new Date('2026-06-29T09:00:00.000Z'));

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 97 * 60 * 60 * 1000);
});

test('Scheduler chunks timeouts that exceed Node maximum delay', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduledTimers = [];
  let executed = 0;

  globalThis.setTimeout = (fn, delayMs) => {
    const timer = { fn, delayMs, cleared: false };
    scheduledTimers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const scheduler = new Scheduler(
      {
        schedule: { enabled: true, timezone: 'UTC' },
        sync: { runOnStart: false, intervalHours: 24 },
        publish: { template: [] },
        logging: { logLevel: 'silent' }
      },
      {}
    );

    scheduler.scheduleTimeout(async () => {
      executed += 1;
    }, 2_147_483_647 + 1_000);

    assert.equal(scheduledTimers.length, 1);
    assert.equal(scheduledTimers[0].delayMs, 2_147_483_647);

    await scheduledTimers[0].fn();

    assert.equal(scheduledTimers.length, 2);
    assert.equal(scheduledTimers[1].delayMs, 1_000);
    assert.equal(executed, 0);

    await scheduledTimers[1].fn();

    assert.equal(executed, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('Scheduler chunks very long timeouts until the exact requested delay is reached', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const maxTimeoutMs = 2_147_483_647;
  const targetDelayMs = maxTimeoutMs * 10 + 100;
  const scheduledTimers = [];
  let executed = 0;

  globalThis.setTimeout = (fn, delayMs) => {
    const timer = { fn, delayMs, cleared: false };
    scheduledTimers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  try {
    const scheduler = new Scheduler(
      {
        schedule: { enabled: true, timezone: 'UTC' },
        sync: { runOnStart: false, intervalHours: 24 },
        publish: { template: [] },
        logging: { logLevel: 'silent' }
      },
      {}
    );

    scheduler.scheduleTimeout(async () => {
      executed += 1;
    }, targetDelayMs);

    let waitedMs = 0;
    for (let index = 0; index < 10; index += 1) {
      assert.equal(scheduledTimers[index].delayMs, maxTimeoutMs);
      assert.equal(executed, 0);
      waitedMs += scheduledTimers[index].delayMs;
      await scheduledTimers[index].fn();
    }

    assert.equal(scheduledTimers.length, 11);
    assert.equal(scheduledTimers[10].delayMs, 100);
    assert.equal(executed, 0);

    waitedMs += scheduledTimers[10].delayMs;
    await scheduledTimers[10].fn();

    assert.equal(waitedMs, targetDelayMs);
    assert.equal(executed, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('Scheduler plans missed publications only after startup sync completes', async () => {
  let resolveSync;
  let resolveCatchup;
  let syncCompleted = false;
  const events = [];
  const syncDone = new Promise((resolve) => {
    resolveSync = resolve;
  });
  const catchupDone = new Promise((resolve) => {
    resolveCatchup = resolve;
  });
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      sync: { runOnStart: true, intervalHours: 24 },
      publish: {
        requestTtlHours: 12,
        template: [
          { source: 'best', key: 'daily_best', enabled: true, schedule: { type: 'daily', time: '10:00' } }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      sync: () => {
        return {
          status: 'running',
          promise: (async () => {
            events.push('sync:start');
            await syncDone;
            syncCompleted = true;
            events.push('sync:end');
          })()
        };
      },
      publish: async () => {
        events.push(`publish:syncCompleted=${syncCompleted}`);
      },
      publishWorker: async () => {
        events.push('worker');
        resolveCatchup();
      }
    }
  );
  scheduler.scheduleSync = () => {};
  scheduler.schedulePublicationWorker = () => {};
  scheduler.schedulePublications = () => {};
  scheduler.planMissedPublications = async function planMissedPublications() {
    await Scheduler.prototype.planMissedPublications.call(this, new Date('2026-06-29T08:00:00.000Z'));
  };

  await scheduler.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['sync:start']);

  resolveSync();
  await catchupDone;

  assert.deepEqual(events, ['sync:start', 'sync:end', 'publish:syncCompleted=true', 'worker']);
});

test('Scheduler plans missed publications inside request TTL without waking worker', async () => {
  const planned = [];
  let workerRuns = 0;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      publish: {
        requestTtlHours: 12,
        template: [
          { source: 'best', key: 'weekly_best', enabled: true, schedule: { type: 'weekly', weekday: 1, time: '10:10' } },
          { source: 'best', key: 'daily_best', enabled: true, schedule: { type: 'daily', time: '10:00' } }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async (key, scheduledAt) => planned.push({ key, scheduledAt: scheduledAt.toISOString() }),
      publishWorker: async () => {
        workerRuns += 1;
      }
    }
  );

  const plannedCount = await scheduler.planMissedPublications(new Date('2026-06-29T08:00:00.000Z'));

  assert.deepEqual(planned, [
    { key: 'best.weekly_best', scheduledAt: '2026-06-29T05:10:00.000Z' },
    { key: 'best.daily_best', scheduledAt: '2026-06-29T05:00:00.000Z' }
  ]);
  assert.equal(plannedCount, 2);
  assert.equal(workerRuns, 0);
});

test('Scheduler plans catch-up checks without waking worker when request already exists', async () => {
  const planned = [];
  let workerRuns = 0;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      publish: {
        requestTtlHours: 12,
        template: [
          { source: 'best', key: 'daily_best', enabled: true, schedule: { type: 'daily', time: '10:00' } }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async (key, scheduledAt) => {
        planned.push({ key, scheduledAt: scheduledAt.toISOString() });
        return {
          selections: [{
            key,
            status: 'exists',
            requested: false
          }]
        };
      },
      publishWorker: async () => {
        workerRuns += 1;
      }
    }
  );

  await scheduler.planMissedPublications(new Date('2026-06-29T08:00:00.000Z'));

  assert.deepEqual(planned, [
    { key: 'best.daily_best', scheduledAt: '2026-06-29T05:00:00.000Z' }
  ]);
  assert.equal(workerRuns, 0);
});

test('Scheduler skips missed publications before firstSendAt', async () => {
  const planned = [];
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'UTC'
      },
      publish: {
        requestTtlHours: 12,
        template: [
          {
            source: 'best',
            key: 'daily_best',
            enabled: true,
            schedule: { type: 'daily', time: '10:00' },
            firstSendAt: '2026-06-30T00:00:00.000Z'
          }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async (key, scheduledAt) => planned.push({ key, scheduledAt: scheduledAt.toISOString() }),
      publishWorker: async () => {}
    }
  );

  const plannedCount = await scheduler.planMissedPublications(new Date('2026-06-29T11:00:00.000Z'));

  assert.equal(plannedCount, 0);
  assert.deepEqual(planned, []);
});

test('Scheduler skips missed publications older than request TTL', async () => {
  const planned = [];
  let workerRuns = 0;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      publish: {
        requestTtlHours: 12,
        template: [
          { source: 'best', key: 'weekly_best', enabled: true, schedule: { type: 'weekly', weekday: 1, time: '10:10' } },
          { source: 'best', key: 'daily_best', enabled: true, schedule: { type: 'daily', time: '10:00' } }
        ]
      },
      logging: { logLevel: 'silent' }
    },
    {
      publish: async (key, scheduledAt) => planned.push({ key, scheduledAt }),
      publishWorker: async () => {
        workerRuns += 1;
      }
    }
  );

  await scheduler.planMissedPublications(new Date('2026-06-30T04:00:00.000Z'));

  assert.deepEqual(planned, []);
  assert.equal(workerRuns, 0);
});

test('getNextLocalTimeAsDate returns same-day target in timezone', () => {
  const target = getNextLocalTimeAsDate({
    now: new Date('2026-06-29T04:00:00.000Z'),
    time: '10:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(target.toISOString(), '2026-06-29T05:00:00.000Z');
});

test('getNextLocalTimeAsDate moves past times to next day', () => {
  const target = getNextLocalTimeAsDate({
    now: new Date('2026-06-29T06:00:00.000Z'),
    time: '09:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(target.toISOString(), '2026-06-30T04:00:00.000Z');
});

test('getDelayUntilLocalTime returns millisecond delay', () => {
  const delay = getDelayUntilLocalTime({
    now: new Date('2026-06-29T04:30:00.000Z'),
    time: '10:00',
    timezone: 'Asia/Yekaterinburg'
  });

  assert.equal(delay, 30 * 60 * 1000);
});

test('getNextScheduledRunAsDate schedules day, week and month at their natural cadence', () => {
  const now = new Date('2026-06-29T06:00:00.000Z');

  assert.equal(getNextScheduledRunAsDate({
    now,
    time: '10:00',
    timezone: 'Asia/Yekaterinburg',
    period: 'day'
  }).toISOString(), '2026-06-30T05:00:00.000Z');
  assert.equal(getNextScheduledRunAsDate({
    now,
    time: '10:00',
    timezone: 'Asia/Yekaterinburg',
    period: 'week'
  }).toISOString(), '2026-07-06T05:00:00.000Z');
  assert.equal(getNextScheduledRunAsDate({
    now,
    time: '10:00',
    timezone: 'Asia/Yekaterinburg',
    period: 'month'
  }).toISOString(), '2026-07-01T05:00:00.000Z');
});

test('getNextEligibleScheduledRunAsDate skips natural runs before firstSendAt', () => {
  const target = getNextEligibleScheduledRunAsDate({
    now: new Date('2026-06-29T09:00:00.000Z'),
    timezone: 'UTC',
    schedule: { type: 'daily', time: '10:00' },
    firstSendAtIso: '2026-07-02T00:00:00.000Z'
  });

  assert.equal(target.toISOString(), '2026-07-02T10:00:00.000Z');
});

test('getPreviousScheduledRunAsDate returns last scheduled day, week and month', () => {
  const now = new Date('2026-06-29T08:00:00.000Z');

  assert.equal(getPreviousScheduledRunAsDate({
    now,
    time: '10:00',
    timezone: 'Asia/Yekaterinburg',
    period: 'day'
  }).toISOString(), '2026-06-29T05:00:00.000Z');
  assert.equal(getPreviousScheduledRunAsDate({
    now,
    time: '10:10',
    timezone: 'Asia/Yekaterinburg',
    period: 'week'
  }).toISOString(), '2026-06-29T05:10:00.000Z');
  assert.equal(getPreviousScheduledRunAsDate({
    now: new Date('2026-06-30T08:00:00.000Z'),
    time: '10:20',
    timezone: 'Asia/Yekaterinburg',
    period: 'month'
  }).toISOString(), '2026-06-01T05:20:00.000Z');
});
