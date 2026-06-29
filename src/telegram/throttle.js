const DEFAULT_KIND = 'history';

export class TelegramThrottle {
  constructor(config = {}, sleepFn = sleep) {
    this.config = config.sync?.throttle || {};
    this.sleepFn = sleepFn;
  }

  async wait(kind = DEFAULT_KIND) {
    if (this.config.enabled === false) return 0;
    const delayMs = getTelegramThrottleDelay(this.config, kind);
    if (delayMs > 0) {
      await this.sleepFn(delayMs);
    }
    return delayMs;
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
  const prefix = kind === 'media' ? 'media' : 'history';
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
