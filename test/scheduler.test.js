import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Scheduler,
  getDelayUntilLocalTime,
  getNextLocalTimeAsDate,
  getNextScheduledRunAsDate,
  getPreviousScheduledRunAsDate
} from '../src/runtime/scheduler.js';

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
      publish: { selections: {} },
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
      publish: { selections: {} },
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
        selections: {
          best: {
            day: { enabled: true, time: '10:00' }
          }
        }
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

test('Scheduler plans missed publications on startup when they are inside request TTL', async () => {
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
        selections: {
          best: {
            day: { enabled: true, time: '10:00' },
            week: { enabled: true, time: '10:10' }
          }
        }
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

  await scheduler.planMissedPublications(new Date('2026-06-29T08:00:00.000Z'));

  assert.deepEqual(planned, [
    { key: 'best.week', scheduledAt: '2026-06-29T05:10:00.000Z' },
    { key: 'best.day', scheduledAt: '2026-06-29T05:00:00.000Z' }
  ]);
  assert.equal(workerRuns, 1);
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
        selections: {
          best: {
            day: { enabled: true, time: '10:00' },
            week: { enabled: true, time: '10:10' }
          }
        }
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
