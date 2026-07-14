import { createClient } from 'redis';
import { getLogger } from '../core/logger.js';

const RESERVE_SCRIPT = `
local slotCount = tonumber(ARGV[1])
local blockCount = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local scheduled = now
local maxPenalty = 1

for i = 1, slotCount do
  local nextAt = tonumber(redis.call('GET', KEYS[i]) or '0')
  if nextAt > scheduled then scheduled = nextAt end
end

for i = 1, blockCount do
  local blockedUntil = tonumber(redis.call('GET', KEYS[slotCount * 2 + i]) or '0')
  if blockedUntil > scheduled then scheduled = blockedUntil end
end

for i = 1, slotCount do
  local penalty = tonumber(redis.call('GET', KEYS[slotCount + i]) or '1')
  if penalty < 1 then penalty = 1 end
  if penalty > maxPenalty then maxPenalty = penalty end
  local interval = math.ceil(tonumber(ARGV[3 + i]) * penalty)
  local dynamicTtl = math.max(ttlMs, scheduled - now + interval + 60000)
  redis.call('SET', KEYS[i], scheduled + interval, 'PX', dynamicTtl)
end

return { scheduled - now, now, scheduled, tostring(maxPenalty) }
`;

const VALIDATE_SCRIPT = `
local scheduledAt = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local blockedUntil = 0
for i = 1, #KEYS do
  local value = tonumber(redis.call('GET', KEYS[i]) or '0')
  if value > blockedUntil then blockedUntil = value end
end
local invalidated = blockedUntil > scheduledAt and 1 or 0
local readyAt = math.max(scheduledAt, blockedUntil)
return { invalidated, math.max(0, readyAt - now), now, blockedUntil }
`;

const BLOCK_SCRIPT = `
local durationMs = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local untilMs = now + durationMs
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if untilMs > current then
    redis.call('SET', KEYS[i], untilMs, 'PX', ttlMs)
  end
end
return untilMs
`;

const PENALTY_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '1')
local updated = math.min(tonumber(ARGV[2]), math.max(1, current * tonumber(ARGV[1])))
redis.call('SET', KEYS[1], tostring(updated), 'PX', tonumber(ARGV[3]))
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('SET', KEYS[2], now, 'PX', tonumber(ARGV[3]))
return tostring(updated)
`;

const REWARD_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '1')
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local lastFloodAt = tonumber(redis.call('GET', KEYS[2]) or '0')
local lastDecayAt = tonumber(redis.call('GET', KEYS[3]) or '0')
if now - lastFloodAt < tonumber(ARGV[3]) or now - lastDecayAt < tonumber(ARGV[4]) then
  return tostring(current)
end
local updated = math.max(1, current * tonumber(ARGV[1]))
if updated <= 1.001 then
  redis.call('DEL', KEYS[1], KEYS[3])
  return '1'
end
redis.call('SET', KEYS[1], tostring(updated), 'PX', tonumber(ARGV[2]))
redis.call('SET', KEYS[3], now, 'PX', tonumber(ARGV[2]))
return tostring(updated)
`;

const FLOOD_SCRIPT = `
local durationMs = tonumber(ARGV[1])
local factor = tonumber(ARGV[2])
local maxPenalty = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local penaltyTtlMs = tonumber(ARGV[5])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local untilMs = now + durationMs
for i = 1, #KEYS - 2 do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if untilMs > current then redis.call('SET', KEYS[i], untilMs, 'PX', ttlMs) end
end
local penaltyKey = KEYS[#KEYS - 1]
local lastFloodKey = KEYS[#KEYS]
local currentPenalty = tonumber(redis.call('GET', penaltyKey) or '1')
local updated = math.min(maxPenalty, math.max(1, currentPenalty * factor))
redis.call('SET', penaltyKey, tostring(updated), 'PX', penaltyTtlMs)
redis.call('SET', lastFloodKey, now, 'PX', penaltyTtlMs)
return { untilMs, tostring(updated) }
`;

export async function createRedisRateLimitStore(config = {}, options = {}) {
  const redisConfig = config.rateLimit?.redis || {};
  if (redisConfig.enabled !== true) return null;

  const logger = options.logger || getLogger('rateLimit.redis');
  let client = options.client;
  try {
    client ||= (options.createClientFn || createClient)({
      url: redisConfig.url || 'redis://127.0.0.1:6379',
      socket: {
        connectTimeout: toPositiveInteger(redisConfig.connectTimeoutMs, 500),
        reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 5000)
      },
      disableOfflineQueue: true
    });
  } catch (error) {
    logger.error('Shared Redis rate limiter could not be initialized; using local fallback', {
      backend: 'redis',
      error: sanitizeError(error)
    });
    return null;
  }
  const store = new RedisRateLimitStore({ client, config: redisConfig, logger });
  await store.start();
  return store;
}

export class RedisRateLimitStore {
  constructor({ client, config = {}, logger = getLogger('rateLimit.redis') }) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.prefix = sanitizeKeyPart(config.keyPrefix || 'tg-memes:rate-limit');
    this.operationTimeoutMs = toPositiveInteger(config.operationTimeoutMs, 200);
    this.circuitBreakMs = toPositiveInteger(config.circuitBreakMs, 5000);
    this.connectTimeoutMs = toPositiveInteger(config.connectTimeoutMs, 500);
    this.ttlMs = toPositiveInteger(config.keyTtlMs, 86_400_000);
    this.penaltyTtlMs = toPositiveInteger(config.penaltyTtlMs, 3_600_000);
    this.penaltyQuietPeriodMs = toPositiveInteger(config.penaltyQuietPeriodMs, 60_000);
    this.penaltyDecayIntervalMs = toPositiveInteger(config.penaltyDecayIntervalMs, 30_000);
    this.lastWarningAt = 0;
    this.warningIntervalMs = toPositiveInteger(config.warningIntervalMs, 30_000);
    this.wasUnavailable = false;
    this.readyLogged = false;
    this.closed = false;
    this.circuitOpenUntil = 0;
    this.instanceId = getInstanceId();
    this.attachEvents();
  }

  async start() {
    if (this.client.isReady) {
      this.logReady('Shared Redis rate limiter ready');
      return true;
    }
    try {
      const connected = await withTimeout(
        Promise.resolve(this.client.connect()),
        this.connectTimeoutMs,
        'Redis connection timed out'
      );
      if (connected !== false && this.client.isReady) {
        this.logReady('Shared Redis rate limiter ready');
        return true;
      }
    } catch (error) {
      this.noteUnavailable('Shared Redis rate limiter unavailable; using local fallback', error);
    }
    return false;
  }

  get isReady() {
    return Boolean(this.client.isReady);
  }

  async reserve({ slots = [], blockKeys = [] }) {
    if (!slots.length) return null;
    const keys = [
      ...slots.map((slot) => this.key(`${slot.key}:next`)),
      ...slots.map((slot) => this.key(`${slot.key}:penalty`)),
      ...blockKeys.map((key) => this.key(`${key}:blocked`))
    ];
    const args = [
      String(slots.length),
      String(blockKeys.length),
      String(this.ttlMs),
      ...slots.map((slot) => String(toNonNegativeInteger(slot.intervalMs)))
    ];
    const outcome = await this.run('reserve', (client) => client.eval(RESERVE_SCRIPT, { keys, arguments: args }), {
      scopes: slots.map((slot) => slot.key),
      blockScopes: blockKeys
    });
    if (outcome.status !== 'ok') return { status: outcome.status, backend: 'redis' };
    const result = outcome.value;
    if (!isValidReservationResult(result)) {
      this.noteUnavailable('Shared Redis rate limiter returned an invalid reservation; using conservative fallback', null, {
        operation: 'reserve'
      });
      this.openCircuit();
      return { status: 'indeterminate', backend: 'redis' };
    }
    return {
      status: 'ok',
      delayMs: Number(result[0]) || 0,
      nowMs: Number(result[1]) || 0,
      scheduledAt: Number(result[2]) || 0,
      penalty: Number(result[3]) || 1,
      backend: 'redis'
    };
  }

  async validate({ blockKeys = [], scheduledAt }) {
    const outcome = await this.run('validate', (client) => client.eval(VALIDATE_SCRIPT, {
      keys: blockKeys.map((key) => this.key(`${key}:blocked`)),
      arguments: [String(toNonNegativeInteger(scheduledAt))]
    }), { blockScopes: blockKeys });
    if (outcome.status !== 'ok') return { status: outcome.status, backend: 'redis' };
    const result = outcome.value;
    if (!Array.isArray(result) || result.length < 4 || result.some((value) => !Number.isFinite(Number(value)))) {
      this.noteUnavailable('Shared Redis rate limiter returned an invalid validation result; using conservative fallback', null, {
        operation: 'validate'
      });
      this.openCircuit();
      return { status: 'indeterminate', backend: 'redis' };
    }
    return {
      status: 'ok',
      invalidated: Number(result[0]) === 1,
      delayMs: Number(result[1]),
      nowMs: Number(result[2]),
      blockedUntil: Number(result[3]),
      backend: 'redis'
    };
  }

  async block({ keys = [], untilMs, durationMs }) {
    if (!keys.length) return false;
    const safeDurationMs = toNonNegativeInteger(
      durationMs ?? (Number(untilMs) - Date.now())
    );
    const ttlMs = Math.max(this.ttlMs, safeDurationMs + 60_000);
    const outcome = await this.run('block', (client) => client.eval(BLOCK_SCRIPT, {
      keys: keys.map((key) => this.key(`${key}:blocked`)),
      arguments: [String(safeDurationMs), String(ttlMs)]
    }), { blockScopes: keys, durationMs: safeDurationMs });
    return outcome.status;
  }

  async penalize(key, factor = 2, max = 8) {
    const outcome = await this.run('penalize', (client) => client.eval(PENALTY_SCRIPT, {
      keys: [this.key(`${key}:penalty`), this.key(`${key}:last-flood`)],
      arguments: [String(factor), String(max), String(this.penaltyTtlMs)]
    }), { scope: key });
    return outcome.status === 'ok' ? Number(outcome.value) : null;
  }

  async reward(key, factor = 0.95) {
    const outcome = await this.run('reward', (client) => client.eval(REWARD_SCRIPT, {
      keys: [
        this.key(`${key}:penalty`),
        this.key(`${key}:last-flood`),
        this.key(`${key}:last-decay`)
      ],
      arguments: [
        String(factor),
        String(this.penaltyTtlMs),
        String(this.penaltyQuietPeriodMs),
        String(this.penaltyDecayIntervalMs)
      ]
    }), { scope: key });
    return outcome.status === 'ok' ? Number(outcome.value) : null;
  }

  async recordFlood({ blockKeys = [], penaltyKey, durationMs, factor = 2, max = 8 }) {
    const safeDurationMs = toNonNegativeInteger(durationMs);
    const ttlMs = Math.max(this.ttlMs, safeDurationMs + 60_000);
    const outcome = await this.run('recordFlood', (client) => client.eval(FLOOD_SCRIPT, {
      keys: [
        ...blockKeys.map((key) => this.key(`${key}:blocked`)),
        this.key(`${penaltyKey}:penalty`),
        this.key(`${penaltyKey}:last-flood`)
      ],
      arguments: [
        String(safeDurationMs),
        String(factor),
        String(max),
        String(ttlMs),
        String(this.penaltyTtlMs)
      ]
    }), { blockScopes: blockKeys, scope: penaltyKey, durationMs: safeDurationMs });
    return outcome.status;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.client.isReady) {
        await this.client.close();
      } else if (this.client.isOpen) {
        this.client.destroy();
      }
    } catch (error) {
      this.logger.debug('Redis rate-limit connection close failed', { error: sanitizeError(error) });
    }
  }

  async run(operation, callback, fields = {}) {
    if (Date.now() < this.circuitOpenUntil) {
      this.logger.debug('Redis rate-limit circuit is open; using local fallback', {
        operation,
        circuitOpenUntil: new Date(this.circuitOpenUntil).toISOString(),
        instanceId: this.instanceId
      });
      return { status: 'unavailable' };
    }
    if (!this.client.isReady) {
      this.noteUnavailable('Shared Redis rate limiter is not ready; using local fallback');
      return { status: 'unavailable' };
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Redis ${operation} timed out`));
    }, this.operationTimeoutMs);
    timeout.unref?.();
    try {
      const client = typeof this.client.withAbortSignal === 'function'
        ? this.client.withAbortSignal(controller.signal)
        : this.client;
      const result = await raceWithAbort(Promise.resolve(callback(client)), controller.signal);
      if (this.wasUnavailable) {
        this.wasUnavailable = false;
        this.logger.info('Shared Redis rate limiter recovered', {
          backend: 'redis',
          instanceId: this.instanceId
        });
      }
      this.logger.debug('Redis rate-limit operation completed', {
        operation,
        backend: 'redis',
        latencyMs: Date.now() - startedAt,
        instanceId: this.instanceId,
        ...fields
      });
      return { status: 'ok', value: result };
    } catch (error) {
      this.openCircuit();
      this.noteUnavailable('Shared Redis rate-limit operation failed; using local fallback', error, { operation });
      return { status: timedOut ? 'indeterminate' : 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  openCircuit() {
    this.circuitOpenUntil = Math.max(this.circuitOpenUntil, Date.now() + this.circuitBreakMs);
  }

  key(suffix) {
    return `${this.prefix}:${sanitizeKeyPart(suffix)}`;
  }

  attachEvents() {
    if (typeof this.client.on !== 'function') return;
    this.client.on('ready', () => {
      this.logReady('Shared Redis rate limiter connected');
    });
    this.client.on('reconnecting', () => {
      this.logger.debug('Shared Redis rate limiter reconnecting', { backend: 'redis' });
    });
    this.client.on('error', (error) => {
      this.noteUnavailable('Shared Redis rate limiter connection error; using local fallback', error);
    });
  }

  noteUnavailable(message, error, fields = {}) {
    this.wasUnavailable = true;
    const now = Date.now();
    const metadata = {
      backend: 'redis',
      instanceId: this.instanceId,
      ...fields,
      error: sanitizeError(error)
    };
    if (now - this.lastWarningAt >= this.warningIntervalMs) {
      this.lastWarningAt = now;
      this.logger.error(message, metadata);
    } else {
      this.logger.debug(message, metadata);
    }
  }

  logReady(message) {
    if (this.readyLogged) return;
    this.readyLogged = true;
    this.logger.info(message, { backend: 'redis', prefix: this.prefix, instanceId: this.instanceId });
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Operation aborted'));
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error('Operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, abortPromise])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function sanitizeKeyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9:{}._-]/g, '_');
}

function isValidReservationResult(result) {
  return Array.isArray(result)
    && result.length >= 4
    && result.slice(0, 4).every((value) => Number.isFinite(Number(value)))
    && Number(result[0]) >= 0
    && Number(result[2]) >= Number(result[1])
    && Number(result[3]) >= 1;
}

function sanitizeError(error) {
  if (!error) return undefined;
  return String(error?.message || error)
    .replace(/redis(s)?:\/\/([^:@/\s]+):([^@/\s]+)@/gi, 'redis$1://$2:[REDACTED]@');
}

function getInstanceId() {
  return process.env.pm_id !== undefined
    ? `pm2:${process.env.pm_id}`
    : `pid:${process.pid}`;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
