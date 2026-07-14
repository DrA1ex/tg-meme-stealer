import { getLogger } from '../core/logger.js';

const logger = getLogger('retry');

export async function withTelegramRetry(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const label = options.label || 'telegram request';
  const sleepFn = options.sleepFn || sleep;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await options.rateLimiter?.wait?.(options.kind);
      const result = await operation();
      await options.rateLimiter?.noteSuccess?.(options.kind);
      return result;
    } catch (error) {
      const waitSeconds = getFloodWaitSeconds(error);
      if (!waitSeconds) throw error;
      const limiterHandledWait = await options.rateLimiter?.noteFloodWait?.(options.kind, waitSeconds) === true;
      if (attempt === maxRetries) throw error;
      const waitMs = (waitSeconds + 1) * 1000;
      logger.warn(`${label} hit FLOOD_WAIT`, {
        waitSeconds,
        retryInSeconds: waitSeconds + 1,
        attempt: attempt + 1,
        maxRetries
      });
      if (limiterHandledWait) continue;
      await sleepFn(waitMs);
    }
  }
}

export async function withBotApiRetry(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const label = options.label || 'bot api request';
  const sleepFn = options.sleepFn || sleep;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await options.rateLimiter?.wait?.(options.chatId);
      return await operation();
    } catch (error) {
      const retryAfter = getBotApiRetryAfterSeconds(error);
      if (!retryAfter) throw error;
      const limiterHandledWait = await options.rateLimiter?.noteRateLimit?.(retryAfter, options.chatId) === true;
      if (attempt === maxRetries) throw error;
      const waitMs = (retryAfter + 1) * 1000;
      logger.warn(`${label} hit Too Many Requests`, {
        retryAfter,
        retryInSeconds: retryAfter + 1,
        attempt: attempt + 1,
        maxRetries
      });
      if (limiterHandledWait) continue;
      await sleepFn(waitMs);
    }
  }
}

export function getFloodWaitSeconds(error) {
  if (typeof error?.seconds === 'number') return error.seconds;
  const match = String(error?.message || error?.text || '').match(/FLOOD_WAIT_(\d+)/);
  if (match) return Number(match[1]);
  if (error?.code === 420 && typeof error?.seconds === 'number') return error.seconds;
  return 0;
}

export function getBotApiRetryAfterSeconds(error) {
  if (typeof error?.response?.parameters?.retry_after === 'number') {
    return error.response.parameters.retry_after;
  }
  if (typeof error?.parameters?.retry_after === 'number') {
    return error.parameters.retry_after;
  }
  const match = String(error?.message || error?.description || error?.response?.description || '').match(/retry after (\d+)/i);
  if (match) return Number(match[1]);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
