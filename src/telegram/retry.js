import { getLogger } from '../core/logger.js';
import { sleepWithSignal } from './rateLimitUtils.js';

const logger = getLogger('retry');

export class TelegramOperationTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} did not settle within ${timeoutMs}ms; delivery outcome is unknown`);
    this.name = 'TelegramOperationTimeoutError';
    this.code = 'TELEGRAM_OPERATION_TIMEOUT';
    this.timeoutMs = timeoutMs;
    this.indeterminate = true;
  }
}

export class TelegramOperationCancelledError extends Error {
  constructor(label, { indeterminate = false, reason } = {}) {
    super(`${label} cancelled during shutdown${indeterminate ? '; delivery outcome is unknown' : ''}`);
    this.name = 'TelegramOperationCancelledError';
    this.code = 'TELEGRAM_OPERATION_CANCELLED';
    this.indeterminate = indeterminate;
    this.reason = reason;
  }
}

export async function withTelegramRetry(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const label = options.label || 'telegram request';
  const sleepFn = options.sleepFn || sleep;
  const onBeforeOperation = onceAsync(options.onBeforeOperation);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      throwIfAborted(options.signal, label);
      await options.rateLimiter?.wait?.(options.kind);
      throwIfAborted(options.signal, label);
      const result = await runTelegramOperation(operation, { ...options, onBeforeOperation }, label);
      await safeLimiterNotification(
        options.rateLimiter,
        'noteSuccess',
        [options.kind],
        `${label} success accounting`
      );
      return result;
    } catch (error) {
      const waitSeconds = getFloodWaitSeconds(error);
      if (!waitSeconds) throw error;
      const hasLimiterHandler = typeof options.rateLimiter?.noteFloodWait === 'function';
      const limiterHandledWait = await safeLimiterNotification(
        options.rateLimiter,
        'noteFloodWait',
        [options.kind, waitSeconds],
        `${label} FLOOD_WAIT accounting`
      ) === true;
      if (attempt === maxRetries) throw error;
      const waitMs = (waitSeconds + 1) * 1000;
      const log = hasLimiterHandler ? logger.debug : logger.warn;
      log(`${label} hit FLOOD_WAIT`, {
        waitSeconds,
        retryInSeconds: waitSeconds + 1,
        attempt: attempt + 1,
        maxRetries
      });
      if (limiterHandledWait) continue;
      await sleepFn(waitMs, options.signal);
    }
  }
}

export async function withBotApiRetry(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const label = options.label || 'bot api request';
  const sleepFn = options.sleepFn || sleep;
  const onBeforeOperation = onceAsync(options.onBeforeOperation);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      throwIfAborted(options.signal, label);
      await options.rateLimiter?.wait?.(options.chatId);
      throwIfAborted(options.signal, label);
      return await runTelegramOperation(operation, { ...options, onBeforeOperation }, label);
    } catch (error) {
      const retryAfter = getBotApiRetryAfterSeconds(error);
      if (!retryAfter) throw error;
      const hasLimiterHandler = typeof options.rateLimiter?.noteRateLimit === 'function';
      const limiterHandledWait = await safeLimiterNotification(
        options.rateLimiter,
        'noteRateLimit',
        [retryAfter, options.chatId],
        `${label} retry_after accounting`
      ) === true;
      if (attempt === maxRetries) throw error;
      const waitMs = (retryAfter + 1) * 1000;
      const log = hasLimiterHandler ? logger.debug : logger.warn;
      log(`${label} hit Too Many Requests`, {
        retryAfter,
        retryInSeconds: retryAfter + 1,
        attempt: attempt + 1,
        maxRetries
      });
      if (limiterHandledWait) continue;
      await sleepFn(waitMs, options.signal);
    }
  }
}

export function getFloodWaitSeconds(error) {
  if (typeof error?.seconds === 'number') return error.seconds;
  const match = String(error?.message || error?.text || '').match(/FLOOD(?:_PREMIUM)?_WAIT_(\d+)/);
  if (match) return Number(match[1]);
  if (error?.code === 420 && typeof error?.seconds === 'number') return error.seconds;
  return 0;
}

async function safeLimiterNotification(rateLimiter, method, args, label) {
  if (typeof rateLimiter?.[method] !== 'function') return undefined;
  try {
    return await rateLimiter[method](...args);
  } catch (error) {
    const message = method === 'noteSuccess'
      ? 'Rate-limiter success accounting failed; preserving Telegram operation result'
      : 'Rate-limiter cooldown accounting failed; using direct retry wait';
    logger.error(message, {
      label,
      method,
      error: error?.message || String(error)
    });
    return undefined;
  }
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

function sleep(ms, signal) {
  return sleepWithSignal(ms, signal);
}

async function runTelegramOperation(operation, options, label) {
  const timeoutMs = positiveNumber(
    options.operationTimeoutMs ?? options.rateLimiter?.operationTimeoutMs,
    60_000
  );
  throwIfAborted(options.signal, label);
  await options.onBeforeOperation?.();
  throwIfAborted(options.signal, label);
  let operationStarted = false;
  let timeout;
  let removeAbortListener = () => {};
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new TelegramOperationTimeoutError(label, timeoutMs)), timeoutMs);
  });
  const abortPromise = createAbortPromise(options.signal, label, () => operationStarted);
  removeAbortListener = abortPromise.removeListener;
  const operationPromise = Promise.resolve().then(() => {
    throwIfAborted(options.signal, label);
    operationStarted = true;
    return operation();
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise, abortPromise.promise]);
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
  }
}

function throwIfAborted(signal, label) {
  if (!signal?.aborted) return;
  throw new TelegramOperationCancelledError(label, { reason: signal.reason });
}

function createAbortPromise(signal, label, isIndeterminate) {
  if (!signal) return { promise: new Promise(() => {}), removeListener() {} };
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(new TelegramOperationCancelledError(label, {
      indeterminate: Boolean(isIndeterminate()),
      reason: signal.reason
    }));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    removeListener() {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

function onceAsync(fn) {
  if (typeof fn !== 'function') return undefined;
  let promise;
  return () => {
    promise ||= Promise.resolve().then(fn);
    return promise;
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
