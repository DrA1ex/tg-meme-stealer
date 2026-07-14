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
  redis.call('SET', KEYS[i], scheduled + interval, 'PX', ttlMs)
end

return { scheduled - now, now, scheduled, tostring(maxPenalty) }
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
return tostring(updated)
`;

const REWARD_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '1')
local updated = math.max(1, current * tonumber(ARGV[1]))
if updated <= 1.001 then
  redis.call('DEL', KEYS[1])
  return '1'
end
redis.call('SET', KEYS[1], tostring(updated), 'PX', tonumber(ARGV[2]))
return tostring(updated)
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
      error: error?.message || String(error)
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
    this.connectTimeoutMs = toPositiveInteger(config.connectTimeoutMs, 500);
    this.ttlMs = toPositiveInteger(config.keyTtlMs, 86_400_000);
    this.penaltyTtlMs = toPositiveInteger(config.penaltyTtlMs, 3_600_000);
    this.lastWarningAt = 0;
    this.warningIntervalMs = toPositiveInteger(config.warningIntervalMs, 30_000);
    this.wasUnavailable = false;
    this.readyLogged = false;
    this.closed = false;
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
    const result = await this.run('reserve', () => this.client.eval(RESERVE_SCRIPT, { keys, arguments: args }));
    if (!Array.isArray(result)) return null;
    return {
      delayMs: Number(result[0]) || 0,
      nowMs: Number(result[1]) || 0,
      scheduledAt: Number(result[2]) || 0,
      penalty: Number(result[3]) || 1,
      backend: 'redis'
    };
  }

  async block({ keys = [], untilMs, durationMs }) {
    if (!keys.length) return false;
    const safeDurationMs = toNonNegativeInteger(
      durationMs ?? (Number(untilMs) - Date.now())
    );
    const ttlMs = Math.max(this.ttlMs, safeDurationMs + 60_000);
    const result = await this.run('block', () => this.client.eval(BLOCK_SCRIPT, {
      keys: keys.map((key) => this.key(`${key}:blocked`)),
      arguments: [String(safeDurationMs), String(ttlMs)]
    }));
    return result !== null;
  }

  async penalize(key, factor = 2, max = 8) {
    const result = await this.run('penalize', () => this.client.eval(PENALTY_SCRIPT, {
      keys: [this.key(`${key}:penalty`)],
      arguments: [String(factor), String(max), String(this.penaltyTtlMs)]
    }));
    return result === null ? null : Number(result);
  }

  async reward(key, factor = 0.95) {
    const result = await this.run('reward', () => this.client.eval(REWARD_SCRIPT, {
      keys: [this.key(`${key}:penalty`)],
      arguments: [String(factor), String(this.penaltyTtlMs)]
    }));
    return result === null ? null : Number(result);
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
      this.logger.debug('Redis rate-limit connection close failed', { error: error?.message || String(error) });
    }
  }

  async run(operation, callback) {
    if (!this.client.isReady) {
      this.noteUnavailable('Shared Redis rate limiter is not ready; using local fallback');
      return null;
    }
    try {
      const result = await withTimeout(Promise.resolve(callback()), this.operationTimeoutMs, `Redis ${operation} timed out`);
      if (this.wasUnavailable) {
        this.wasUnavailable = false;
        this.logger.info('Shared Redis rate limiter recovered', { backend: 'redis' });
      }
      this.logger.debug('Redis rate-limit operation completed', { operation, backend: 'redis' });
      return result;
    } catch (error) {
      this.noteUnavailable('Shared Redis rate-limit operation failed; using local fallback', error, { operation });
      return null;
    }
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
    const metadata = { backend: 'redis', ...fields, error: error?.message || (error ? String(error) : undefined) };
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
    this.logger.info(message, { backend: 'redis', prefix: this.prefix });
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

function sanitizeKeyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9:{}._-]/g, '_');
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
