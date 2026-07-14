import { getLogger } from '../core/logger.js';

const DEFAULT_KIND = 'history';

export class TelegramThrottle {
  constructor(config = {}, sleepFn = sleep, nowFn = Date.now, sharedStore = null) {
    this.config = config.sync?.throttle || {};
    this.sharedConfig = config.rateLimit || {};
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.sharedStore = sharedStore;
    this.logger = getLogger('rateLimit.mtproto');
    this.group = String(this.sharedConfig.mtprotoGroup || 'default');
    this.nextAllowedAt = new Map();
    this.blockedUntil = 0;
    this.penalties = new Map();
  }

  async wait(kind = DEFAULT_KIND) {
    if (this.config.enabled === false) return 0;
    const now = this.nowFn();
    const baseIntervalMs = getTelegramThrottleDelay(this.config, kind);
    const shared = await this.sharedStore?.reserve({
      slots: [{ key: this.scope(kind), intervalMs: baseIntervalMs }],
      blockKeys: [this.globalScope()]
    });
    const redisExpected = this.sharedConfig.redis?.enabled === true;
    const usingFallback = redisExpected && !shared;
    const fallbackMultiplier = usingFallback
      ? Math.max(1, Number(this.sharedConfig.redis?.fallbackMultiplier) || 3)
      : 1;
    const intervalMs = Math.round(
      baseIntervalMs * (this.penalties.get(kind) || 1) * fallbackMultiplier
    );
    const hasLocalReservation = this.nextAllowedAt.has(kind);
    const scheduledAt = Math.max(
      now,
      this.blockedUntil,
      this.nextAllowedAt.get(kind) || 0,
      usingFallback && !hasLocalReservation ? now + intervalMs : 0
    );
    const localDelayMs = Math.max(0, scheduledAt - now);
    this.nextAllowedAt.set(kind, scheduledAt + intervalMs);
    const delayMs = Math.max(localDelayMs, shared?.delayMs || 0);
    const backend = shared ? 'redis+memory' : usingFallback ? 'memory-fallback' : 'memory';
    if (delayMs > 0) {
      this.logger.info('Waiting for MTProto rate-limit slot', {
        kind,
        delayMs,
        backend,
        sharedDelayMs: shared?.delayMs,
        penalty: shared?.penalty || this.penalties.get(kind) || 1,
        fallbackMultiplier: usingFallback ? fallbackMultiplier : undefined,
        group: this.group
      });
      await this.sleepFn(delayMs);
    } else {
      this.logger.debug('MTProto rate-limit slot acquired', { kind, backend, group: this.group });
    }
    return delayMs;
  }

  async noteFloodWait(kind = DEFAULT_KIND, waitSeconds = 0) {
    if (this.config.enabled === false) return false;
    const bufferMs = toNonNegativeNumber(this.config.retryBufferMs ?? 1000);
    const untilMs = this.nowFn() + waitSeconds * 1000 + bufferMs;
    this.blockedUntil = Math.max(this.blockedUntil, untilMs);
    const current = this.penalties.get(kind) || 1;
    this.penalties.set(kind, Math.min(current * 2, 8));
    this.logger.warn('MTProto FLOOD_WAIT applied to rate limiter', {
      kind,
      waitSeconds,
      blockedUntil: new Date(untilMs).toISOString(),
      penalty: this.penalties.get(kind),
      backend: this.sharedStore?.isReady
        ? 'redis+memory'
        : this.sharedConfig.redis?.enabled === true ? 'memory-fallback' : 'memory',
      group: this.group
    });
    await Promise.all([
      this.sharedStore?.block({
        keys: [this.globalScope()],
        untilMs,
        durationMs: waitSeconds * 1000 + bufferMs
      }),
      this.sharedStore?.penalize(this.scope(kind), 2, 8)
    ]);
    return true;
  }

  async noteSuccess(kind = DEFAULT_KIND) {
    const current = this.penalties.get(kind) || 1;
    if (current > 1) this.penalties.set(kind, Math.max(1, current * 0.95));
    await this.sharedStore?.reward(this.scope(kind), 0.95);
  }

  scope(kind) {
    return `mtproto:${this.group}:${kind}`;
  }

  globalScope() {
    return `mtproto:${this.group}`;
  }
}

export function getTelegramThrottleDelay(config = {}, kind = DEFAULT_KIND, random = Math.random) {
  const range = getTelegramThrottleRange(config, kind);
  if (range.maxMs <= 0) return 0;
  if (range.maxMs <= range.minMs) return range.minMs;
  const randomValue = Math.min(Math.max(random(), 0), 0.999999999);
  return Math.floor(range.minMs + randomValue * (range.maxMs - range.minMs + 1));
}

export function getTelegramThrottleRange(config = {}, kind = DEFAULT_KIND) {
  const prefix = kind === 'media' ? 'media' : kind === 'reactions' ? 'reactions' : 'history';
  const minMs = toNonNegativeNumber(config[`${prefix}MinMs`] ?? config.minMs ?? 0);
  const maxMs = toNonNegativeNumber(config[`${prefix}MaxMs`] ?? config.maxMs ?? minMs);
  return maxMs < minMs ? { minMs: maxMs, maxMs: minMs } : { minMs, maxMs };
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
