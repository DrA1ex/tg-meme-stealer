import { getLogger } from '../core/logger.js';
import { assertQueueDeadline, getQueueDeadline, sleepWithSignal } from './rateLimitUtils.js';

export class BotApiRateLimiter {
  constructor(config = {}, sleepFn = null, nowFn = Date.now, sharedStore = null, randomFn = Math.random) {
    this.config = config.publish?.throttle || {};
    this.sharedConfig = config.rateLimit || {};
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.sharedStore = sharedStore;
    this.operationTimeoutMs = positiveNumber(this.sharedConfig.telegramOperationTimeoutMs, 60_000);
    this.randomFn = randomFn;
    this.redisExpected = config.rateLimit?.redis?.enabled === true;
    this.logger = getLogger('rateLimit.botApi');
    this.botId = getBotRateLimitId(config.telegram?.botToken);
    this.nextGlobalAt = 0;
    this.nextChatAt = new Map();
    this.nextFallbackGlobalAt = 0;
    this.nextFallbackChatAt = new Map();
    this.nextDestinationAt = new Map();
    this.blockedUntil = 0;
    this.abortController = new AbortController();
  }

  async wait(chatId) {
    if (this.config.enabled === false) return 0;
    const now = this.nowFn();
    const deadlineAt = getQueueDeadline(now, this.sharedConfig);
    const key = String(chatId);
    const globalMinMs = toNonNegativeNumber(this.config.globalMinMs ?? 40);
    const perChatMinMs = toNonNegativeNumber(this.config.perChatMinMs ?? 1100);
    const scheduledAt = Math.max(now, this.blockedUntil, this.nextGlobalAt, this.nextChatAt.get(key) || 0);
    this.nextGlobalAt = scheduledAt + globalMinMs;
    this.nextChatAt.set(key, scheduledAt + perChatMinMs);
    const localDelayMs = Math.max(0, scheduledAt - now);
    const slots = [
      { key: this.globalScope(), intervalMs: globalMinMs },
      { key: this.chatScope(chatId), intervalMs: perChatMinMs }
    ];
    const sharedDestinationMinMs = this.getSharedDestinationMinMs();
    if (sharedDestinationMinMs > 0) {
      slots.push({ key: this.destinationScope(chatId), intervalMs: sharedDestinationMinMs });
    }
    const blockKeys = [this.globalScope(), this.chatScope(chatId)];
    if (sharedDestinationMinMs > 0) blockKeys.push(this.destinationScope(chatId));
    const shared = await this.sharedStore?.reserve({
      slots,
      blockKeys
    });
    const sharedOk = shared?.status === 'ok';
    const usingFallback = this.redisExpected && !sharedOk;
    let tokenFallbackDelayMs = 0;
    let destinationFallbackDelayMs = 0;
    if (usingFallback) {
      const multiplier = Math.max(1, Number(this.sharedConfig.redis?.fallbackMultiplier) || 3);
      const fallbackScheduledAt = Math.max(
        now,
        this.blockedUntil,
        this.nextFallbackGlobalAt,
        this.nextFallbackChatAt.get(key) || 0
      );
      tokenFallbackDelayMs = Math.max(0, fallbackScheduledAt - now);
      this.nextFallbackGlobalAt = fallbackScheduledAt + globalMinMs * multiplier;
      this.nextFallbackChatAt.set(key, fallbackScheduledAt + perChatMinMs * multiplier);
    }
    if (usingFallback && sharedDestinationMinMs > 0) {
      const multiplier = Math.max(1, Number(this.sharedConfig.redis?.fallbackMultiplier) || 3);
      const fallbackIntervalMs = sharedDestinationMinMs * multiplier;
      const existing = this.nextDestinationAt.get(key);
      const destinationAt = existing || now + fallbackIntervalMs
        + Math.floor(this.randomFn() * fallbackIntervalMs);
      destinationFallbackDelayMs = Math.max(0, destinationAt - now);
      this.nextDestinationAt.set(key, destinationAt + fallbackIntervalMs);
    }
    const delayMs = Math.max(
      localDelayMs,
      sharedOk ? shared.delayMs : 0,
      tokenFallbackDelayMs,
      destinationFallbackDelayMs
    );
    const backend = sharedOk ? 'redis+memory' : usingFallback ? 'memory-fallback' : 'memory';
    const logFields = {
      chatId,
      backend,
      sharedDelayMs: sharedOk ? shared.delayMs : undefined,
      tokenFallbackDelayMs: usingFallback ? tokenFallbackDelayMs : undefined,
      destinationFallbackDelayMs: usingFallback ? destinationFallbackDelayMs : undefined,
      redisStatus: shared?.status,
      botId: this.botId
    };
    if (delayMs > 0) {
      await this.waitDelay(delayMs, logFields, deadlineAt);
    } else {
      this.logger.debug('Bot API rate-limit slot acquired', { chatId, backend, botId: this.botId });
    }
    if (sharedOk) await this.confirmSharedReservation(chatId, slots, blockKeys, shared, deadlineAt);
    return delayMs;
  }

  async noteRateLimit(retryAfterSeconds = 0, chatId) {
    if (this.config.enabled === false) return false;
    const until = this.nowFn()
      + retryAfterSeconds * 1000
      + toNonNegativeNumber(this.config.retryBufferMs ?? 1000);
    this.blockedUntil = Math.max(this.blockedUntil, until);
    if (chatId !== undefined && chatId !== null) {
      const key = String(chatId);
      this.nextChatAt.set(key, Math.max(this.nextChatAt.get(key) || 0, until));
    }
    this.logger.warn('Bot API retry_after applied to rate limiter', {
      chatId,
      retryAfterSeconds,
      blockedUntil: new Date(until).toISOString(),
      backend: this.sharedStore?.isReady
        ? 'redis+memory'
        : this.redisExpected ? 'memory-fallback' : 'memory',
      botId: this.botId
    });
    const keys = [this.globalScope()];
    if (chatId !== undefined && chatId !== null) keys.push(this.chatScope(chatId));
    if (chatId !== undefined && chatId !== null
      && this.config.shareRetryAfterAcrossBots === true
      && this.getSharedDestinationMinMs() > 0) {
      keys.push(this.destinationScope(chatId));
    }
    await this.sharedStore?.block({
      keys,
      untilMs: until,
      durationMs: retryAfterSeconds * 1000 + toNonNegativeNumber(this.config.retryBufferMs ?? 1000)
    });
    return true;
  }

  async confirmSharedReservation(chatId, slots, blockKeys, initialReservation, deadlineAt) {
    let reservation = initialReservation;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const validation = await this.sharedStore.validate({ blockKeys, scheduledAt: reservation.scheduledAt });
      if (validation.status !== 'ok') {
        await this.waitConservativeFallback(chatId, validation.status, 'reservation_validation_failed', deadlineAt);
        return;
      }
      if (validation.invalidated) {
        this.logger.info('Bot API reservation invalidated by a newer shared cooldown', {
          chatId,
          blockedUntil: new Date(validation.blockedUntil).toISOString(),
          botId: this.botId
        });
        reservation = await this.sharedStore.reserve({ slots, blockKeys });
        if (reservation.status !== 'ok') {
          await this.waitConservativeFallback(chatId, reservation.status, 'reservation_requeue_failed', deadlineAt);
          return;
        }
        if (reservation.delayMs > 0) {
          await this.waitDelay(reservation.delayMs, {
            chatId,
            backend: 'redis+memory',
            botId: this.botId,
            reason: 'reservation_requeued'
          }, deadlineAt);
        }
        continue;
      }
      if (validation.delayMs > 0) {
        await this.waitDelay(validation.delayMs, {
          chatId,
          backend: 'redis+memory',
          botId: this.botId,
          reason: 'reservation_not_due'
        }, deadlineAt);
        continue;
      }
      return;
    }
    throw new Error(`Unable to confirm Bot API rate-limit reservation for chat ${chatId}`);
  }

  async waitConservativeFallback(chatId, redisStatus, reason, deadlineAt) {
    const multiplier = Math.max(1, Number(this.sharedConfig.redis?.fallbackMultiplier) || 3);
    const baseMs = Math.max(
      toNonNegativeNumber(this.config.globalMinMs ?? 40),
      toNonNegativeNumber(this.config.perChatMinMs ?? 1100),
      this.getSharedDestinationMinMs(),
      1
    );
    const delayMs = baseMs * multiplier + Math.floor(this.randomFn() * baseMs * multiplier);
    await this.waitDelay(delayMs, {
      chatId,
      backend: 'memory-fallback',
      redisStatus,
      botId: this.botId,
      reason
    }, deadlineAt);
  }

  async waitDelay(delayMs, fields, deadlineAt = getQueueDeadline(this.nowFn(), this.sharedConfig)) {
    const longWait = assertQueueDeadline(delayMs, deadlineAt, this.nowFn(), this.sharedConfig, this.logger, {
      ...fields,
      scope: this.chatScope(fields.chatId)
    });
    const log = longWait ? this.logger.warn : this.logger.info;
    log('Waiting for Bot API rate-limit slot', { delayMs, ...fields });
    if (this.sleepFn) await this.sleepFn(delayMs);
    else await sleepWithSignal(delayMs, this.abortController.signal);
  }

  close() {
    this.abortController.abort();
  }

  globalScope() {
    return `bot-api:${this.botId}`;
  }

  chatScope(chatId) {
    return `bot-api:${this.botId}:chat:${chatId}`;
  }

  destinationScope(chatId) {
    return `bot-api:destination:${chatId}`;
  }

  getSharedDestinationMinMs() {
    return toNonNegativeNumber(this.config.sharedDestinationMinMs ?? 350);
  }
}

export function getBotRateLimitId(botToken) {
  const id = String(botToken || '').split(':', 1)[0];
  return /^\d+$/.test(id) ? id : 'unknown';
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
