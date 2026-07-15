import { SharedRateLimitUnavailableError } from './redisRateLimitStore.js';
import { getLogger } from '../core/logger.js';
import { assertQueueDeadline, getQueueDeadline, sleepWithSignal } from './rateLimitUtils.js';

const DEFAULT_KIND = 'history';

export class TelegramThrottle {
  constructor(config = {}, sleepFn = null, nowFn = Date.now, sharedStore = null) {
    this.config = config.sync?.throttle || {};
    this.sharedConfig = config.rateLimit || {};
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.sharedStore = sharedStore;
    this.operationTimeoutMs = positiveNumber(this.sharedConfig.telegramOperationTimeoutMs, 60_000);
    this.redisRequired = config.rateLimit?.redis?.required === true;
    this.logger = getLogger('rateLimit.mtproto');
    this.group = String(this.sharedConfig.mtprotoGroup || 'default');
    this.nextAllowedAt = new Map();
    this.blockedUntil = 0;
    this.penalties = new Map();
    this.lastFloodAt = new Map();
    this.lastPenaltyDecayAt = new Map();
    this.lastRewardAttemptAt = new Map();
    this.abortController = new AbortController();
  }

  async wait(kind = DEFAULT_KIND) {
    if (this.config.enabled === false) return 0;
    const now = this.nowFn();
    const deadlineAt = getQueueDeadline(now, this.sharedConfig);
    const baseIntervalMs = getTelegramThrottleDelay(this.config, kind);
    const blockKeys = [this.globalScope()];
    const shared = await this.sharedStore?.reserve({
      slots: [{ key: this.scope(kind), intervalMs: baseIntervalMs }],
      blockKeys
    });
    const sharedOk = shared?.status === 'ok';
    this.assertSharedAvailable(shared?.status, 'reserve');
    const redisExpected = this.sharedConfig.redis?.enabled === true;
    const usingFallback = redisExpected && !sharedOk;
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
    const delayMs = Math.max(localDelayMs, sharedOk ? shared.delayMs : 0);
    const backend = sharedOk ? 'redis+memory' : usingFallback ? 'memory-fallback' : 'memory';
    const logFields = {
      kind,
      backend,
      sharedDelayMs: sharedOk ? shared.delayMs : undefined,
      penalty: sharedOk ? shared.penalty : this.penalties.get(kind) || 1,
      fallbackMultiplier: usingFallback ? fallbackMultiplier : undefined,
      group: this.group,
      redisStatus: shared?.status
    };
    if (delayMs > 0) {
      await this.waitDelay(delayMs, logFields, deadlineAt);
    } else {
      this.logger.debug('MTProto rate-limit slot acquired', { kind, backend, group: this.group });
    }
    if (sharedOk) await this.confirmSharedReservation(kind, baseIntervalMs, blockKeys, shared, deadlineAt);
    return delayMs;
  }

  async noteFloodWait(kind = DEFAULT_KIND, waitSeconds = 0) {
    if (this.config.enabled === false) return false;
    const bufferMs = toNonNegativeNumber(this.config.retryBufferMs ?? 1000);
    const untilMs = this.nowFn() + waitSeconds * 1000 + bufferMs;
    this.blockedUntil = Math.max(this.blockedUntil, untilMs);
    const current = this.penalties.get(kind) || 1;
    this.penalties.set(kind, Math.min(current * 2, 8));
    this.lastFloodAt.set(kind, this.nowFn());
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
    await this.sharedStore?.recordFlood({
      blockKeys: [this.globalScope()],
      penaltyKey: this.scope(kind),
      durationMs: waitSeconds * 1000 + bufferMs,
      factor: 2,
      max: 8
    });
    return true;
  }

  async noteSuccess(kind = DEFAULT_KIND) {
    const now = this.nowFn();
    const quietPeriodMs = positiveNumber(this.sharedConfig.redis?.penaltyQuietPeriodMs, 60_000);
    const decayIntervalMs = positiveNumber(this.sharedConfig.redis?.penaltyDecayIntervalMs, 30_000);
    const current = this.penalties.get(kind) || 1;
    const canDecayLocal = now - (this.lastFloodAt.get(kind) || 0) >= quietPeriodMs
      && now - (this.lastPenaltyDecayAt.get(kind) || 0) >= decayIntervalMs;
    if (current > 1 && canDecayLocal) {
      this.penalties.set(kind, Math.max(1, current * 0.95));
      this.lastPenaltyDecayAt.set(kind, now);
    }
    const lastRewardAttemptAt = this.lastRewardAttemptAt.get(kind);
    if (lastRewardAttemptAt === undefined || now - lastRewardAttemptAt >= decayIntervalMs) {
      this.lastRewardAttemptAt.set(kind, now);
      await this.sharedStore?.reward(this.scope(kind), 0.95);
    }
  }

  async confirmSharedReservation(kind, baseIntervalMs, blockKeys, initialReservation, deadlineAt) {
    let reservation = initialReservation;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const validation = await this.sharedStore.validate({ blockKeys, scheduledAt: reservation.scheduledAt });
      if (validation.status !== 'ok') {
        this.assertSharedAvailable(validation.status, 'validate');
        const fallbackMs = baseIntervalMs * Math.max(
          1,
          Number(this.sharedConfig.redis?.fallbackMultiplier) || 3
        );
        await this.waitDelay(fallbackMs, {
          kind,
          backend: 'memory-fallback',
          redisStatus: validation.status,
          group: this.group,
          reason: 'reservation_validation_failed'
        }, deadlineAt);
        return;
      }
      if (validation.invalidated) {
        this.logger.info('MTProto reservation invalidated by a newer shared cooldown', {
          kind,
          blockedUntil: new Date(validation.blockedUntil).toISOString(),
          group: this.group
        });
        reservation = await this.sharedStore.reserve({
          slots: [{ key: this.scope(kind), intervalMs: baseIntervalMs }],
          blockKeys
        });
        if (reservation.status !== 'ok') {
          this.assertSharedAvailable(reservation.status, 'requeue');
          const fallbackMs = baseIntervalMs * Math.max(
            1,
            Number(this.sharedConfig.redis?.fallbackMultiplier) || 3
          );
          await this.waitDelay(fallbackMs, {
            kind,
            backend: 'memory-fallback',
            redisStatus: reservation.status,
            group: this.group,
            reason: 'reservation_requeue_failed'
          }, deadlineAt);
          return;
        }
        if (reservation.delayMs > 0) {
          await this.waitDelay(reservation.delayMs, {
            kind,
            backend: 'redis+memory',
            group: this.group,
            reason: 'reservation_requeued'
          }, deadlineAt);
        }
        continue;
      }
      if (validation.delayMs > 0) {
        await this.waitDelay(validation.delayMs, {
          kind,
          backend: 'redis+memory',
          group: this.group,
          reason: 'reservation_not_due'
        }, deadlineAt);
        continue;
      }
      return;
    }
    throw new Error(`Unable to confirm MTProto rate-limit reservation for ${kind}`);
  }

  async waitDelay(delayMs, fields, deadlineAt = getQueueDeadline(this.nowFn(), this.sharedConfig)) {
    const longWait = assertQueueDeadline(delayMs, deadlineAt, this.nowFn(), this.sharedConfig, this.logger, {
      ...fields,
      scope: this.scope(fields.kind)
    });
    const log = longWait ? this.logger.warn : this.logger.info;
    log('Waiting for MTProto rate-limit slot', { delayMs, ...fields });
    if (this.sleepFn) await this.sleepFn(delayMs);
    else await sleepWithSignal(delayMs, this.abortController.signal);
  }

  assertSharedAvailable(status, operation) {
    if (!this.redisRequired || status === 'ok') return;
    throw new SharedRateLimitUnavailableError(`Required Redis rate limiter is unavailable during MTProto ${operation}`);
  }

  close() {
    this.abortController.abort();
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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
