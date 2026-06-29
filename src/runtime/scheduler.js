import { getScheduledPublishEntries } from '../core/selection.js';

export class Scheduler {
  constructor(config, handlers) {
    this.config = config;
    this.handlers = typeof handlers === 'function' ? { sync: handlers, publishAll: handlers } : handlers;
    this.timers = new Set();
    this.running = new Set();
  }

  async start() {
    if (!this.config.schedule.enabled) return;
    if (this.config.schedule.runOnStart) {
      await this.run('sync', () => this.handlers.sync());
    }
    this.scheduleSync();
    this.schedulePublications();
  }

  scheduleSync() {
    const intervalMs = (this.config.schedule.syncIntervalHours || this.config.schedule.intervalHours || 24) * 60 * 60 * 1000;
    this.scheduleTimeout(async () => {
      await this.run('sync', () => this.handlers.sync());
      this.scheduleSync();
    }, intervalMs);
  }

  schedulePublications(now = new Date()) {
    for (const entry of getScheduledPublishEntries(this.config)) {
      this.schedulePublication(entry.key, entry.time, now);
    }
  }

  schedulePublication(key, time, now = new Date()) {
    const delayMs = getDelayUntilLocalTime({
      now,
      time,
      timezone: this.config.schedule.timezone
    });
    this.scheduleTimeout(async () => {
      await this.run(`publish:${key}`, () => this.handlers.publish(key));
      this.schedulePublication(key, time);
    }, delayMs);
  }

  async run(key, fn) {
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      await fn();
    } catch (error) {
      console.error(`Scheduled job failed (${key}):`, error);
    } finally {
      this.running.delete(key);
    }
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export function getDelayUntilLocalTime({ now = new Date(), time, timezone }) {
  const target = getNextLocalTimeAsDate({ now, time, timezone });
  return target.getTime() - now.getTime();
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
