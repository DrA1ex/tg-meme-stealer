import { getLogger } from '../core/logger.js';
import { getNextLocalTimeAsDate } from './scheduler.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const DEFAULT_CHUNK_LIMIT = 3600;

export class ErrorLogCollector {
  constructor({
    repository,
    nowFn = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logger = getLogger('errorLogs')
  } = {}) {
    if (!repository) throw new TypeError('ErrorLogCollector requires a repository');
    this.repository = repository;
    this.nowFn = nowFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.logger = logger;
    this.writeTail = Promise.resolve();
    this.fallbackEvents = [];
    this.nextFallbackId = 1;
    this.notifier = null;
    this.digestTime = '12:00';
    this.timezone = 'UTC';
    this.timer = null;
    this.closed = false;
  }

  record(event = {}) {
    if (this.closed || event.level !== 'error') return;
    const normalized = normalizeErrorEvent(event, new Date(this.nowFn()));
    this.writeTail = this.writeTail
      .then(() => this.repository.addPendingErrorLog(normalized))
      .catch((error) => {
        this.fallbackEvents.push({ ...normalized, fallbackId: this.nextFallbackId++ });
        this.logger.warn('Failed to persist ERROR log; keeping it in memory', {
          error: error?.message || String(error),
          type: normalized.type,
          scope: normalized.scope
        });
      });
  }

  setNotifier(notifier) {
    this.notifier = typeof notifier === 'function' ? notifier : null;
  }

  startDailyDigest({ timezone, time = '12:00' } = {}) {
    this.timezone = String(timezone || 'UTC');
    this.digestTime = String(time || '12:00');
    this.stopDailyDigest();
    this.scheduleNextDigest();
  }

  stopDailyDigest() {
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  async flushPending({
    sendMessage = this.notifier,
    title = 'Application ERROR logs',
    sendEmpty = false
  } = {}) {
    if (typeof sendMessage !== 'function') throw new TypeError('A sendMessage function is required');
    await this.writeTail;

    const databaseEvents = await this.repository.listPendingErrorLogs();
    const fallbackEvents = this.fallbackEvents.map((event) => ({ ...event }));
    const events = [...databaseEvents, ...fallbackEvents]
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || Number(a.id || 0) - Number(b.id || 0));

    if (events.length === 0) {
      if (sendEmpty) await sendMessage('No pending ERROR logs.');
      return { sent: false, cleared: 0, remaining: 0 };
    }

    const maxDatabaseId = databaseEvents.at(-1)?.id || 0;
    const fallbackIds = new Set(fallbackEvents.map((event) => event.fallbackId));
    const chunks = formatErrorDigest(events, { title });

    for (const chunk of chunks) await sendMessage(chunk);

    if (maxDatabaseId > 0) await this.repository.deletePendingErrorLogsThrough(maxDatabaseId);
    if (fallbackIds.size > 0) {
      this.fallbackEvents = this.fallbackEvents.filter((event) => !fallbackIds.has(event.fallbackId));
    }

    const remaining = await this.pendingCount();
    return { sent: true, cleared: events.length, remaining };
  }

  async pendingCount() {
    await this.writeTail;
    return Number(await this.repository.countPendingErrorLogs()) + this.fallbackEvents.length;
  }

  scheduleNextDigest() {
    if (this.closed || !this.notifier || this.timer) return;
    const now = new Date(this.nowFn());
    const nextRunAt = getNextLocalTimeAsDate({
      now,
      time: this.digestTime,
      timezone: this.timezone
    });
    const delayMs = Math.max(1, nextRunAt.getTime() - now.getTime());
    this.logger.info('Daily ERROR digest scheduled', {
      time: this.digestTime,
      timezone: this.timezone,
      nextRunAt,
      delayMs
    });
    this.timer = this.setTimeoutFn(async () => {
      this.timer = null;
      try {
        await this.flushPending({
          title: 'Daily application ERROR digest',
          sendEmpty: false
        });
      } catch (error) {
        this.logger.warn('Failed to send daily ERROR digest; pending logs retained', {
          error: error?.message || String(error)
        });
      } finally {
        if (!this.closed) this.scheduleNextDigest();
      }
    }, delayMs);
    this.timer?.unref?.();
  }

  async close() {
    this.closed = true;
    this.stopDailyDigest();
    this.notifier = null;
    await this.writeTail;
  }
}

export function formatErrorDigest(events = [], {
  title = 'Application ERROR logs',
  chunkLimit = DEFAULT_CHUNK_LIMIT
} = {}) {
  const groups = groupErrorEvents(events);
  const total = events.length;
  const header = `${title}: ${total} event${total === 1 ? '' : 's'}, ${groups.length} type${groups.length === 1 ? '' : 's'}.`;
  const blocks = groups.map(formatErrorGroup);
  return chunkBlocks(header, blocks, Math.min(TELEGRAM_MESSAGE_LIMIT - 128, positiveNumber(chunkLimit, DEFAULT_CHUNK_LIMIT)));
}

export function getErrorType({ scope = '', message = '', fields = {} } = {}) {
  const errorText = stringifyError(fields.error || fields.lastError || fields.reason || '');
  const explicitCode = fields.errorCode || fields.code;
  if (explicitCode) return normalizeType(explicitCode);

  const combined = `${errorText}\n${message}`;
  const telegramCode = combined.match(/Telegram API error\s+\d+\s*:\s*([A-Z][A-Z0-9_]+)/i)?.[1];
  if (telegramCode) return normalizeType(telegramCode);

  const redisTimeout = errorText.match(/^Redis\s+([a-z0-9_.-]+)\s+timed out$/i)?.[1];
  if (redisTimeout) return `REDIS_${normalizeType(redisTimeout)}_TIMEOUT`;

  const symbolicCode = combined.match(/\b([A-Z][A-Z0-9_]{3,})\b/)?.[1];
  if (symbolicCode && symbolicCode !== 'ERROR') return normalizeType(symbolicCode);

  const timeout = combined.match(/\b([a-z0-9_.-]+)\s+timed out\b/i)?.[1];
  if (timeout) return `${normalizeType(scope || 'APP')}_${normalizeType(timeout)}_TIMEOUT`;

  return normalizeType(`${scope || 'app'}_${message || 'error'}`);
}

function normalizeErrorEvent(event, now) {
  const timestamp = event.now instanceof Date
    ? event.now.toISOString()
    : event.timestamp
      ? new Date(event.timestamp).toISOString()
      : now.toISOString();
  const fields = sanitizeFields(event.fields || {});
  return {
    timestamp,
    scope: String(event.scope || 'app'),
    message: String(event.message || 'Error'),
    type: getErrorType({ ...event, fields }),
    error: stringifyError(fields.error || fields.lastError || ''),
    fields
  };
}

function groupErrorEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const group = groups.get(event.type) || {
      type: event.type,
      count: 0,
      firstAt: event.timestamp,
      lastAt: event.timestamp,
      scopes: new Set(),
      events: []
    };
    group.count += 1;
    group.lastAt = event.timestamp;
    group.scopes.add(event.scope);
    group.events.push(event);
    groups.set(event.type, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function formatErrorGroup(group) {
  const header = [
    `${group.type} × ${group.count}`,
    `Scopes: ${[...group.scopes].sort().join(', ')}`,
    `First: ${group.firstAt}`,
    `Last: ${group.lastAt}`
  ].join('\n');
  const events = group.events.map((event, index) => formatErrorEvent(event, index + 1));
  return `${header}\n${events.join('\n')}`;
}

function formatErrorEvent(event, index) {
  const fields = formatDiagnosticFields(event.fields);
  return [
    `${index}. ${event.timestamp} [${event.scope}] ${truncate(event.message, 500)}`,
    event.error ? `   Error: ${truncate(event.error, 800)}` : '',
    fields ? `   Fields: ${truncate(fields, 1200)}` : ''
  ].filter(Boolean).join('\n');
}

function formatDiagnosticFields(fields = {}) {
  const diagnosticFields = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => (
      value !== undefined && !['error', 'lastError', 'errorCode'].includes(key)
    ))
  );
  if (Object.keys(diagnosticFields).length === 0) return '';
  try {
    return JSON.stringify(diagnosticFields);
  } catch {
    return String(diagnosticFields);
  }
}

function chunkBlocks(header, blocks, limit) {
  const chunks = [];
  let current = header;
  for (const block of blocks) {
    const addition = `\n\n${block}`;
    if (current.length + addition.length <= limit) {
      current += addition;
      continue;
    }
    chunks.push(current);
    if (block.length + header.length + 2 <= limit) {
      current = `${header}\n\n${block}`;
      continue;
    }
    const available = Math.max(256, limit - header.length - 2);
    for (let offset = 0; offset < block.length; offset += available) {
      chunks.push(`${header}\n\n${block.slice(offset, offset + available)}`);
    }
    current = header;
  }
  if (current !== header || chunks.length === 0) chunks.push(current);
  return chunks;
}

function sanitizeFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else if (value instanceof Error) {
      result[key] = value.message;
    } else if (typeof value === 'bigint') {
      result[key] = value.toString();
    } else if (typeof value === 'object' && value !== null) {
      try {
        result[key] = JSON.parse(JSON.stringify(value, (nestedKey, nestedValue) => (
          isSensitiveKey(nestedKey) ? '[REDACTED]' : nestedValue
        )));
      } catch {
        result[key] = String(value);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isSensitiveKey(key) {
  return /token|api.?hash|password|secret|authorization|session/i.test(String(key || ''));
}

function stringifyError(value) {
  if (value instanceof Error) return value.message;
  if (value === undefined || value === null) return '';
  return String(value);
}

function normalizeType(value) {
  return String(value || 'ERROR')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 96) || 'ERROR';
}

function truncate(value, maxLength) {
  const string = String(value || '');
  return string.length <= maxLength ? string : `${string.slice(0, maxLength - 1)}…`;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
