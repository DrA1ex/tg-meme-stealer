import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, getDelayUntilLocalTime, getNextLocalTimeAsDate, getNextScheduledRunAsDate } from '../src/runtime/scheduler.js';

test('Scheduler.start does not wait for startup sync before returning', async () => {
  let syncStarted = false;
  let syncScheduled = false;
  let publicationsScheduled = false;
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        runOnStart: true,
        syncIntervalHours: 24,
        timezone: 'Asia/Yekaterinburg'
      },
      publish: { selections: {} },
      logging: { level: 'silent' }
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
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        runOnStart: true,
        syncIntervalHours: 24,
        timezone: 'Asia/Yekaterinburg'
      },
      publish: { selections: {} },
      logging: { level: 'silent' }
    },
    {
      sync: () => {
        syncRuns += 1;
        return new Promise(() => {});
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

  assert.equal(syncRuns, 1);
  assert.equal(scheduledCallbacks.length, 2);
});

test('Scheduler serializes publication jobs across different selection keys', async () => {
  let releaseFirst;
  let activePublishJobs = 0;
  let maxActivePublishJobs = 0;
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const events = [];
  const scheduler = new Scheduler(
    {
      schedule: {
        enabled: true,
        timezone: 'Asia/Yekaterinburg'
      },
      logging: { level: 'silent' }
    },
    {}
  );

  const first = scheduler.run('publish:best.week', async () => {
    activePublishJobs += 1;
    maxActivePublishJobs = Math.max(maxActivePublishJobs, activePublishJobs);
    events.push('first:start');
    await firstCanFinish;
    events.push('first:end');
    activePublishJobs -= 1;
  });
  await Promise.resolve();

  const second = scheduler.run('publish:controversial.week', async () => {
    activePublishJobs += 1;
    maxActivePublishJobs = Math.max(maxActivePublishJobs, activePublishJobs);
    events.push('second:start');
    events.push('second:end');
    activePublishJobs -= 1;
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['first:start']);
  assert.equal(maxActivePublishJobs, 1);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(maxActivePublishJobs, 1);
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
