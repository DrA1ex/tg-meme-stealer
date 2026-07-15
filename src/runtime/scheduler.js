import { getScheduledPublishEntries } from '../core/selection.js';
import { getLogger } from '../core/logger.js';

const MAX_TIMEOUT_MS = 2_147_483_647;
const TIMER_INFO_THRESHOLD_MS = 3 * 60 * 60 * 1000;

export class Scheduler {
  constructor(config, handlers, logger = getLogger('scheduler')) {
    this.config = config;
    this.handlers = typeof handlers === 'function' ? { sync: handlers, publish: handlers } : handlers;
    this.logger = logger;
    this.timers = new Set();
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
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
    this.scheduleRetention({ initial: true });
    this.schedulePublicationWorker();
    this.schedulePublications();
    this.logger.debug('Scheduler started', { timers: this.timers.size });
    if (this.config.sync.runOnStart) {
      this.logger.info('Running startup sync');
      void runHandler(this.handlers.sync)
        .then(() => this.planMissedPublications())
        .then(() => this.handlers.publishWorker())
        .catch((error) => this.logScheduledError('startup', error));
    } else {
      void this.planMissedPublications()
        .then(() => this.handlers.publishWorker())
        .catch((error) => this.logScheduledError('startup', error));
    }
  }

  scheduleSync() {
    const intervalMs = this.config.sync.intervalHours * 60 * 60 * 1000;
    const nextRunAt = new Date(Date.now() + intervalMs);
    this.logTimerScheduled({
      timer: 'sync',
      intervalHours: intervalMs / 60 / 60 / 1000,
      delayMs: intervalMs,
      nextRunAt
    });
    this.scheduleTimeout(async () => {
      await this.runScheduled('sync', () => runHandler(this.handlers.sync), () => this.scheduleSync());
    }, intervalMs);
  }

  scheduleRetention({ initial = false } = {}) {
    if (!this.handlers.retention) return;
    const delayMs = getRetentionDelayMs(this.config, initial);
    this.logTimerScheduled({
      timer: 'retention',
      initial,
      delayMs,
      nextRunAt: new Date(Date.now() + delayMs)
    });
    this.scheduleTimeout(async () => {
      await this.runScheduled('retention', () => runHandler(this.handlers.retention), () => this.scheduleRetention());
    }, delayMs);
  }

  schedulePublications(now = new Date()) {
    for (const entry of getScheduledPublishEntries(this.config)) {
      this.schedulePublication(entry.key, entry.schedule, now, entry.firstSendAtIso);
    }
  }

  schedulePublication(key, schedule, now = new Date(), firstSendAtIso = null) {
    const unrestrictedNextRunAt = getNextScheduledRunAsDate({
      now,
      schedule,
      timezone: this.config.schedule.timezone
    });
    const nextRunAt = getNextEligibleScheduledRunAsDate({
      now,
      schedule,
      timezone: this.config.schedule.timezone,
      firstSendAtIso
    });
    if (nextRunAt.getTime() !== unrestrictedNextRunAt.getTime()) {
      this.logger.info('Publication timer shifted by first send gate', {
        key,
        scheduleType: schedule.type,
        time: schedule.time,
        timezone: this.config.schedule.timezone,
        skippedNextRunAt: unrestrictedNextRunAt,
        blockedUntil: firstSendAtIso,
        nextRunAt
      });
    }
    const delayMs = nextRunAt.getTime() - now.getTime();
    this.logTimerScheduled({
      timer: 'publication',
      key,
      scheduleType: schedule.type,
      time: schedule.time,
      timezone: this.config.schedule.timezone,
      delayMs,
      nextRunAt
    });
    this.scheduleTimeout(async () => {
      await this.runScheduled(`publication:${key}`, async () => {
        const result = await resolveHandlerResult(this.handlers.publish(key, nextRunAt));
        if (hasScheduledPublicationRequest(result)) await this.handlers.publishWorker();
      }, () => this.schedulePublication(key, schedule, undefined, firstSendAtIso));
    }, delayMs);
  }

  async planMissedPublications(now = new Date()) {
    const requestTtlMs = Math.max(1, Number(this.config.publish?.requestTtlHours ?? 12)) * 60 * 60 * 1000;
    let planned = 0;

    for (const entry of getScheduledPublishEntries(this.config)) {
      const scheduledAt = getPreviousScheduledRunAsDate({
        now,
        schedule: entry.schedule,
        timezone: this.config.schedule.timezone
      });
      const ageMs = now.getTime() - scheduledAt.getTime();
      if (isBeforeFirstSendAt(scheduledAt, entry.firstSendAtIso)) {
        this.logger.info('Catch-up publication skipped before first send gate', {
          key: entry.key,
          scheduledAt,
          blockedUntil: entry.firstSendAtIso
        });
        continue;
      }
      if (ageMs < 0 || ageMs > requestTtlMs) {
        this.logger.debug('Missed publication skipped', {
          key: entry.key,
          scheduledAt,
          ageMs,
          requestTtlMs
        });
        continue;
      }

      const result = await resolveHandlerResult(this.handlers.publish(entry.key, scheduledAt));
      if (hasScheduledPublicationRequest(result)) {
        this.logger.info('Catch-up publication scheduled', {
          key: entry.key,
          scheduledAt,
          ageMs,
          requestTtlMs
        });
        planned += 1;
      } else {
        this.logger.debug('Catch-up publication skipped', {
          key: entry.key,
          scheduledAt,
          ageMs,
          requestTtlMs,
          statuses: getPublicationStatuses(result)
        });
      }
    }

    return planned;
  }

  schedulePublicationWorker() {
    const intervalMs = Math.max(1, Number(this.config.publish?.workerIntervalMinutes ?? 10)) * 60 * 1000;
    this.logTimerScheduled({
      timer: 'publication_worker',
      intervalMinutes: intervalMs / 60 / 1000,
      delayMs: intervalMs,
      nextRunAt: new Date(Date.now() + intervalMs)
    });
    this.scheduleTimeout(async () => {
      await this.runScheduled(
        'publication_worker',
        () => this.handlers.publishWorker(),
        () => this.schedulePublicationWorker()
      );
    }, intervalMs);
  }

  logTimerScheduled(fields) {
    const log = Number(fields.delayMs || 0) > TIMER_INFO_THRESHOLD_MS
      ? this.logger.info
      : this.logger.debug;
    log('Timer scheduled', fields);
  }

  scheduleTimeout(fn, delayMs) {
    const timeout = {
      timer: null,
      cancelled: false
    };
    const totalDelayMs = Math.max(0, Number(delayMs) || 0);

    const scheduleChunk = (remainingMs) => {
      if (timeout.cancelled) return;
      const chunkMs = Math.min(remainingMs, MAX_TIMEOUT_MS);
      if (remainingMs > MAX_TIMEOUT_MS) {
        this.logger.debug('Long timeout chunk scheduled', {
          delayMs: totalDelayMs,
          chunkMs,
          remainingMs
        });
      }

      timeout.timer = setTimeout(async () => {
        this.timers.delete(timeout);
        const nextRemainingMs = remainingMs - chunkMs;
        if (nextRemainingMs > 0) {
          scheduleChunk(nextRemainingMs);
          return;
        }
        await fn();
      }, chunkMs);
      this.timers.add(timeout);
    };

    scheduleChunk(totalDelayMs);
    return timeout;
  }

  stop() {
    this.stopped = true;
    this.logger.debug('Scheduler stopping', { timers: this.timers.size });
    for (const timeout of this.timers) {
      timeout.cancelled = true;
      clearTimeout(timeout.timer);
    }
    this.timers.clear();
    this.logger.debug('Scheduler stopped');
  }

  async runScheduled(timer, fn, reschedule) {
    try {
      await fn();
    } catch (error) {
      this.logScheduledError(timer, error);
    } finally {
      if (!this.stopped) reschedule();
    }
  }

  logScheduledError(timer, error) {
    this.logger.error('Scheduled handler failed', {
      timer,
      error: error?.message || String(error)
    });
  }
}

function getRetentionDelayMs(config, initial) {
  if (initial) {
    return Math.max(0, Number(config.sync?.retentionInitialDelayMinutes ?? 15)) * 60 * 1000;
  }
  return Math.max(1, Number(config.sync?.retentionIntervalHours ?? 24)) * 60 * 60 * 1000;
}

async function runHandler(handler) {
  const job = await handler();
  const result = job?.promise ? await job.promise : job;
  if (result?.failed) {
    const error = new Error(result.error || 'Scheduled job failed');
    error.result = result;
    throw error;
  }
  return result;
}

async function resolveHandlerResult(result) {
  const resolved = await result;
  if (resolved?.promise) return resolved.promise;
  return resolved;
}

function hasScheduledPublicationRequest(result) {
  if (result?.skipped) return false;
  if (!result || !Array.isArray(result.selections)) return true;
  return result.selections.some((selection) => selection.requested || selection.status === 'scheduled');
}

function getPublicationStatuses(result) {
  if (!result || !Array.isArray(result.selections)) return '';
  return result.selections.map((selection) => `${selection.key}:${selection.status}`).join(',');
}

export function getDelayUntilLocalTime({ now = new Date(), time, timezone }) {
  const target = getNextLocalTimeAsDate({ now, time, timezone });
  return target.getTime() - now.getTime();
}

export function getNextScheduledRunAsDate({ now = new Date(), time, timezone, period = 'day', schedule: configuredSchedule = null }) {
  const schedule = normalizeScheduleArgument({ time, period, schedule: configuredSchedule });
  if (schedule.type === 'monthly') return getNextMonthlyRunAsDate({ now, schedule, timezone });
  if (schedule.type === 'weekly') return getNextWeeklyRunAsDate({ now, schedule, timezone });
  return getNextLocalTimeAsDate({ now, time: schedule.time, timezone });
}

export function getNextEligibleScheduledRunAsDate({ now = new Date(), time, timezone, period = 'day', schedule: configuredSchedule = null, firstSendAtIso = null }) {
  const firstSendAt = firstSendAtIso ? new Date(firstSendAtIso) : null;
  let target = getNextScheduledRunAsDate({ now, time, timezone, period, schedule: configuredSchedule });
  if (!firstSendAt || Number.isNaN(firstSendAt.getTime())) return target;

  let guard = 0;
  while (target < firstSendAt) {
    target = getNextScheduledRunAsDate({ now: target, time, timezone, period, schedule: configuredSchedule });
    guard += 1;
    if (guard > 10000) throw new Error('Unable to find eligible scheduled run after firstSendAt');
  }
  return target;
}

export function getPreviousScheduledRunAsDate({ now = new Date(), time, timezone, period = 'day', schedule: configuredSchedule = null }) {
  const schedule = normalizeScheduleArgument({ time, period, schedule: configuredSchedule });
  if (schedule.type === 'monthly') return getPreviousMonthlyRunAsDate({ now, schedule, timezone });
  if (schedule.type === 'weekly') return getPreviousWeeklyRunAsDate({ now, schedule, timezone });
  return getPreviousLocalTimeAsDate({ now, time: schedule.time, timezone });
}

function isBeforeFirstSendAt(scheduledAt, firstSendAtIso) {
  if (!firstSendAtIso) return false;
  const firstSendAt = new Date(firstSendAtIso);
  if (Number.isNaN(firstSendAt.getTime())) return false;
  return scheduledAt < firstSendAt;
}

function normalizeScheduleArgument({ schedule, time, period }) {
  if (schedule) return schedule;
  if (period === 'month') return { type: 'monthly', dayOfMonth: 1, time };
  if (period === 'week') return { type: 'weekly', weekday: 1, time };
  return { type: 'daily', time };
}

export function getNextLocalTimeAsDate({ now = new Date(), time, timezone }) {
  const [hour, minute] = parseTime(time);
  const local = getLocalParts(now, timezone);
  let daysToAdd = 0;
  if (local.hour > hour || local.hour === hour && local.minute >= minute) daysToAdd = 1;
  const target = normalizeCivilDate({ ...local, day: local.day + daysToAdd, hour, minute });
  return resolveZonedDateTime(target, timezone, 'compatible');
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
    hourCycle: 'h23'
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
  return asUtc - truncateToMinute(date).getTime();
}

function getNextWeeklyRunAsDate({ now, schedule, timezone }) {
  const local = getLocalParts(now, timezone);
  const currentWeekday = getCalendarWeekday(local);
  const targetWeekday = schedule.weekday;
  let daysToAdd = (targetWeekday - currentWeekday + 7) % 7;
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: local.day + daysToAdd,
    time: schedule.time,
    timezone
  });
  if (target <= now) {
    daysToAdd += 7;
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month,
      day: local.day + daysToAdd,
      time: schedule.time,
      timezone
    });
  }
  return target;
}

function getNextMonthlyRunAsDate({ now, schedule, timezone }) {
  const local = getLocalParts(now, timezone);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: schedule.dayOfMonth,
    time: schedule.time,
    timezone
  });
  if (target <= now) {
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month + 1,
      day: schedule.dayOfMonth,
      time: schedule.time,
      timezone
    });
  }
  return target;
}

function getPreviousWeeklyRunAsDate({ now, schedule, timezone }) {
  const local = getLocalParts(now, timezone);
  const currentWeekday = getCalendarWeekday(local);
  const targetWeekday = schedule.weekday;
  let daysToAdd = -((currentWeekday - targetWeekday + 7) % 7);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: local.day + daysToAdd,
    time: schedule.time,
    timezone
  });
  if (target > now) {
    daysToAdd -= 7;
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month,
      day: local.day + daysToAdd,
      time: schedule.time,
      timezone
    });
  }
  return target;
}

function getPreviousMonthlyRunAsDate({ now, schedule, timezone }) {
  const local = getLocalParts(now, timezone);
  let target = getLocalDateTimeAsDate({
    year: local.year,
    month: local.month,
    day: schedule.dayOfMonth,
    time: schedule.time,
    timezone
  });
  if (target > now) {
    target = getLocalDateTimeAsDate({
      year: local.year,
      month: local.month - 1,
      day: schedule.dayOfMonth,
      time: schedule.time,
      timezone
    });
  }
  return target;
}

function getLocalDateTimeAsDate({ year, month, day, time, timezone }) {
  const [hour, minute] = parseTime(time);
  return resolveZonedDateTime(normalizeCivilDate({ year, month, day, hour, minute }), timezone, 'compatible');
}

function resolveZonedDateTime(target, timezone, disambiguation = 'compatible') {
  const naiveUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(getTimezoneOffsetMs(new Date(naiveUtc + hours * 60 * 60 * 1000), timezone));
  }

  const matches = [...offsets]
    .map((offsetMs) => new Date(naiveUtc - offsetMs))
    .filter((candidate) => civilPartsEqual(getLocalParts(candidate, timezone), target))
    .sort((a, b) => a - b);
  if (matches.length > 0) return disambiguation === 'later' ? matches.at(-1) : matches[0];

  // The local clock skipped over this time (spring DST transition). Match Temporal's
  // compatible behavior by selecting the first real instant after the gap.
  const searchStart = naiveUtc - 18 * 60 * 60 * 1000;
  const searchEnd = naiveUtc + 18 * 60 * 60 * 1000;
  let best = null;
  for (let instant = searchStart; instant <= searchEnd; instant += 60_000) {
    const candidate = new Date(instant);
    const local = getLocalParts(candidate, timezone);
    if (compareCivilParts(local, target) >= 0 && sameCivilDate(local, target)) {
      best = candidate;
      break;
    }
  }
  if (best) return best;
  throw new Error(`Unable to resolve local time ${formatCivil(target)} in ${timezone}`);
}

function normalizeCivilDate({ year, month, day, hour = 0, minute = 0 }) {
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  return {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
    day: normalized.getUTCDate(),
    hour: normalized.getUTCHours(),
    minute: normalized.getUTCMinutes()
  };
}

function truncateToMinute(date) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function civilPartsEqual(left, right) {
  return compareCivilParts(left, right) === 0;
}

function compareCivilParts(left, right) {
  return civilScalar(left) - civilScalar(right);
}

function civilScalar(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
}

function sameCivilDate(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function formatCivil(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function getCalendarWeekday(local) {
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay() || 7;
}

export function getLocalTimestampBucket(date, timezone) {
  const local = getLocalParts(date, timezone);
  return `${local.year}-${pad2(local.month)}-${pad2(local.day)}T${pad2(local.hour)}-${pad2(local.minute)}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
