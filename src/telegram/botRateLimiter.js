import { getLogger } from '../core/logger.js';

export class BotApiRateLimiter {
  constructor(config = {}, sleepFn = sleep, nowFn = Date.now, sharedStore = null) {
    this.config = config.publish?.throttle || {};
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.sharedStore = sharedStore;
    this.redisExpected = config.rateLimit?.redis?.enabled === true;
    this.logger = getLogger('rateLimit.botApi');
    this.botId = getBotRateLimitId(config.telegram?.botToken);
    this.nextGlobalAt = 0;
    this.nextChatAt = new Map();
    this.blockedUntil = 0;
  }

  async wait(chatId) {
    if (this.config.enabled === false) return 0;
    const now = this.nowFn();
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
    const delayMs = Math.max(localDelayMs, shared?.delayMs || 0);
    const backend = shared ? 'redis+memory' : this.redisExpected ? 'memory-fallback' : 'memory';
    if (delayMs > 0) {
      this.logger.info('Waiting for Bot API rate-limit slot', {
        chatId,
        delayMs,
        backend,
        sharedDelayMs: shared?.delayMs,
        botId: this.botId
      });
      await this.sleepFn(delayMs);
    } else {
      this.logger.debug('Bot API rate-limit slot acquired', { chatId, backend, botId: this.botId });
    }
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
    const keys = [this.globalScope(), this.chatScope(chatId)];
    if (this.getSharedDestinationMinMs() > 0) keys.push(this.destinationScope(chatId));
    await this.sharedStore?.block({
      keys,
      untilMs: until,
      durationMs: retryAfterSeconds * 1000 + toNonNegativeNumber(this.config.retryBufferMs ?? 1000)
    });
    return true;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
