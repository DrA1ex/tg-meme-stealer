export class RateLimitQueueDelayError extends Error {
  constructor(delayMs, maxDelayMs, scope) {
    super(`Rate-limit queue delay ${delayMs}ms exceeds maximum ${maxDelayMs}ms for ${scope}`);
    this.name = 'RateLimitQueueDelayError';
    this.code = 'RATE_LIMIT_QUEUE_DELAY_EXCEEDED';
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
    this.scope = scope;
  }
}

export class RateLimitCancelledError extends Error {
  constructor() {
    super('Rate-limit wait cancelled during shutdown');
    this.name = 'RateLimitCancelledError';
    this.code = 'RATE_LIMIT_CANCELLED';
  }
}

export function assertQueueDelay(delayMs, config = {}, logger, fields = {}) {
  const maxDelayMs = positiveNumber(config.maxQueueDelayMs, 300_000);
  const longWaitWarnMs = positiveNumber(config.longWaitWarnMs, 10_000);
  if (delayMs > maxDelayMs) {
    logger.warn('Rate-limit queue delay exceeds configured maximum', { delayMs, maxDelayMs, ...fields });
    throw new RateLimitQueueDelayError(delayMs, maxDelayMs, fields.scope || fields.kind || 'unknown');
  }
  return delayMs >= longWaitWarnMs;
}

export function getQueueDeadline(nowMs, config = {}) {
  return nowMs + positiveNumber(config.maxQueueDelayMs, 300_000);
}

export function assertQueueDeadline(delayMs, deadlineAt, nowMs, config = {}, logger, fields = {}) {
  const remainingMs = Math.max(0, deadlineAt - nowMs);
  if (delayMs > remainingMs) {
    const maxDelayMs = positiveNumber(config.maxQueueDelayMs, 300_000);
    logger.warn('Rate-limit operation exceeded its total wait budget', {
      delayMs,
      remainingMs,
      maxDelayMs,
      ...fields
    });
    throw new RateLimitQueueDelayError(delayMs, remainingMs, fields.scope || fields.kind || 'unknown');
  }
  return assertQueueDelay(delayMs, config, logger, fields);
}

export function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(new RateLimitCancelledError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done(new RateLimitCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    function done(error) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
