import { getScheduledPublishEntries } from '../core/selection.js';
import { createLogger } from '../core/logger.js';

export class Scheduler {
  constructor(config, handlers, logger = createLogger(config, 'scheduler')) {
    this.config = config;
    this.handlers = typeof handlers === 'function' ? { sync: handlers, publish: handlers } : handlers;
    this.logger = logger;
    this.timers = new Set();
  }

  async start() {
    if (!this.config.schedule.enabled) {
      this.logger.debug('Scheduler disabled');
      return;
    }
    this.logger.debug('Scheduler starting', {
      timezone: this.config.schedule.timezone,
      syncIntervalHours: this.config.sync.intervalHours,
      runOnStart: Boolean(this.config.sync.runOnStart)
    });
    this.scheduleSync();
    this.schedulePublicationWorker();
    this.schedulePublications();
    this.logger.debug('Scheduler started', { timers: this.timers.size });
    if (this.config.sync.runOnStart) {
      this.logger.info('Running startup sync');
      void runHandler(this.handlers.sync)
        .then(() => this.planMissedPublications());
    } else {
      void this.planMissedPublications();
    }
  }

  scheduleSync() {
    const intervalMs = this.config.sync.intervalHours * 60 * 60 * 1000;
    const nextRunAt = new Date(Date.now() + intervalMs);
    this.logger.debug('Scheduled sync', {
      intervalHours: intervalMs / 60 / 60 / 1000,
      delayMs: intervalMs,
      nextRunAt
    });
    this.scheduleTimeout(async () => {
      await runHandler(this.handlers.sync);
      this.scheduleSync();
    }, intervalMs);
  }

  schedulePublications(now = new Date()) {
    for (const entry of getScheduledPublishEntries(this.config)) {
      this.schedulePublication(entry.key, entry.time, now);
    }
  }

  schedulePublication(key, time, now = new Date()) {
    const period = getPeriodFromSelectionKey(key);
    const nextRunAt = getNextScheduledRunAsDate({
      now,
      time,
      timezone: this.config.schedule.timezone,
      period
    });
    const delayMs = nextRunAt.getTime() - now.getTime();
    this.logger.debug('Scheduled publication', {
      key,
      period,
      time,
      timezone: this.config.schedule.timezone,
      delayMs,
      nextRunAt
    });
    this.scheduleTimeout(async () => {
      await this.handlers.publish(key, new Date());
      await this.handlers.publishWorker();
      this.schedulePublication(key, time);
    }, delayMs);
  }

  async planMissedPublications(now = new Date()) {
    const requestTtlMs = Math.max(1, Number(this.config.publish?.requestTtlHours ?? 12)) * 60 * 60 * 1000;
    let planned = 0;

    for (const entry of getScheduledPublishEntries(this.config)) {
      const scheduledAt = getPreviousScheduledRunAsDate({
        now,
        time: entry.time,
        timezone: this.config.schedule.timezone,
        period: entry.period
      });
      const ageMs = now.getTime() - scheduledAt.getTime();
      if (ageMs < 0 || ageMs > requestTtlMs) {
        this.logger.debug('Missed publication skipped', {
          key: entry.key,
          scheduledAt,
          ageMs,
          requestTtlMs
        });
        continue;
      }

      this.logger.info('Planning missed publication', {
        key: entry.key,
        scheduledAt,
        ageMs,
        requestTtlMs
      });
      await this.handlers.publish(entry.key, scheduledAt);
      planned += 1;
    }

    if (planned > 0) {
      await this.handlers.publishWorker();
    }
  }

  schedulePublicationWorker() {
    const intervalMs = Math.max(1, Number(this.config.publish?.workerIntervalMinutes ?? 1)) * 60 * 1000;
    this.logger.debug('Scheduled publication worker', { intervalMs, nextRunAt: new Date(Date.now() + intervalMs) });
    void this.handlers.publishWorker();
    this.scheduleTimeout(async () => {
      await this.handlers.publishWorker();
      this.schedulePublicationWorker();
    }, intervalMs);
  }

  scheduleTimeout(fn, delayMs) {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      await fn();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  stop() {
    this.logger.debug('Scheduler stopping', { timers: this.timers.size });
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.logger.debug('Scheduler stopped');
  }
}

async function runHandler(handler) {
  const job = await handler();
  if (job?.promise) await job.promise;
  return job;
}

export function getDelayUntilLocalTime({ now = new Date(), time, timezone }) {
  const target = getNextLocalTimeAsDate({ now, time, timezone });
  return target.getTime() - now.getTime();
}

export function getNextScheduledRunAsDate({ now = new Date(), time, timezone, period = 'day' }) {
  if (period === 'month') return getNextMonthlyRunAsDate({ now, time, timezone });
  if (period === 'week') return getNextWeeklyRunAsDate({ now, time, timezone });
  return getNextLocalTimeAsDate({ now, time, timezone });
}

export function getPreviousScheduledRunAsDate({ now = new Date(), time, timezone, period = 'day' }) {
  if (period === 'month') return getPreviousMonthlyRunAsDate({ now, time, timezone });
  if (period === 'week') return getPreviousWeeklyRunAsDate({ now, time, timezone });
  return getPreviousLocalTimeAsDate({ now, time, timezone });
}

export function getNextLocalTimeAsDate({ now = new Date(), time, timezone }) {
  const [hour, minute] = parseTime(time);
  const local = getLocalParts(now, timezone);
  let daysToAdd = 0;
  if (local.hour > hour || local.hour === hour && local.minute >= minute) {
    daysToAdd = 1;
  }

  const localMiddayUtc = Date.UTC(local.year, local.month - 1, local.day + daysToAdd, 12, 0, 0);
  const targetParts = getLocalParts(new Date(localMiddayUtc), timezone);
  const utcGuess = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day, hour, minute, 0);
  const offsetMs = getTimezoneOffsetMs(new Date(utcGuess), timezone);
  return new Date(utcGuess - offsetMs);
}

export function getPreviousLocalTimeAsDate({ now = new Date(), time, timezone }) {
  const [hour, minute] = parseTime(time);
  const local = getLocalParts(now, timezone);
  let daysToAdd = 0;
  if (local.hour < hour || local.hour === hour && local.minute < minute) {
    daysToAdd = -1;
  }

  return getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: local.day + daysToAdd,
    time,
    timezone
  });
}

function parseTime(time) {
  const match = String(time).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid schedule time: ${time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid schedule time: ${time}`);
  return [hour, minute];
}

function getLocalParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function getTimezoneOffsetMs(date, timezone) {
  const local = getLocalParts(date, timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  return asUtc - date.getTime();
}

function getNextWeeklyRunAsDate({ now, time, timezone }) {
  const local = getLocalParts(now, timezone);
  const currentWeekday = getCalendarWeekday(local);
  const targetWeekday = 1;
  let daysToAdd = (targetWeekday - currentWeekday + 7) % 7;
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: local.day + daysToAdd,
    time,
    timezone
  });
  if (target <= now) {
    daysToAdd += 7;
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month,
      day: local.day + daysToAdd,
      time,
      timezone
    });
  }
  return target;
}

function getNextMonthlyRunAsDate({ now, time, timezone }) {
  const local = getLocalParts(now, timezone);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: 1,
    time,
    timezone
  });
  if (target <= now) {
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month + 1,
      day: 1,
      time,
      timezone
    });
  }
  return target;
}

function getPreviousWeeklyRunAsDate({ now, time, timezone }) {
  const local = getLocalParts(now, timezone);
  const currentWeekday = getCalendarWeekday(local);
  const targetWeekday = 1;
  let daysToAdd = -((currentWeekday - targetWeekday + 7) % 7);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: local.day + daysToAdd,
    time,
    timezone
  });
  if (target > now) {
    daysToAdd -= 7;
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month,
      day: local.day + daysToAdd,
      time,
      timezone
    });
  }
  return target;
}

function getPreviousMonthlyRunAsDate({ now, time, timezone }) {
  const local = getLocalParts(now, timezone);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: 1,
    time,
    timezone
  });
  if (target > now) {
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month - 1,
      day: 1,
      time,
      timezone
    });
  }
  return target;
}

function getLocalDateTimeAsDate({ year, month, day, time, timezone }) {
  const [hour, minute] = parseTime(time);
  const localMiddayUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const targetParts = getLocalParts(new Date(localMiddayUtc), timezone);
  const utcGuess = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day, hour, minute, 0);
  const offsetMs = getTimezoneOffsetMs(new Date(utcGuess), timezone);
  return new Date(utcGuess - offsetMs);
}

function getCalendarWeekday(local) {
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}

function getPeriodFromSelectionKey(key) {
  return String(key).split('.')[1] || 'day';
}
