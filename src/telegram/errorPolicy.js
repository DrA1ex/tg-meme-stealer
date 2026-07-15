import { sleepWithSignal } from './rateLimitUtils.js';

const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

const PERMANENT_HTTP_CODES = new Set([400, 401, 403, 404, 405, 406, 410, 413, 414, 415, 422]);
const TRANSIENT_HTTP_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function classifyTelegramError(error) {
  if (error?.telegramFailureClass) return error.telegramFailureClass;
  if (error?.indeterminate === true) return 'indeterminate';
  if (error?.code === 'PUBLICATION_LEASE_LOST' || error?.reason?.code === 'PUBLICATION_LEASE_LOST') return 'lease_lost';
  if (error?.code === 'MEDIA_TOO_LARGE' || error?.code === 'ENOENT') return 'permanent';
  if (error?.code === 'TELEGRAM_OPERATION_CANCELLED') return error.indeterminate ? 'indeterminate' : 'cancelled';

  const status = getStatusCode(error);
  if (TRANSIENT_HTTP_CODES.has(status)) return 'network';
  if (PERMANENT_HTTP_CODES.has(status)) return 'permanent';

  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (NETWORK_CODES.has(code)) return 'network';

  const text = String(
    error?.description ||
    error?.response?.description ||
    error?.message ||
    error ||
    ''
  ).toLowerCase();

  if (/flood_wait|too many requests|retry after/.test(text)) return 'network';
  if (/network|socket|timed? ?out|connection (?:closed|reset|refused)|fetch failed|temporary failure|bad gateway|service unavailable|gateway timeout/.test(text)) {
    return 'network';
  }
  if (/bad request|forbidden|unauthorized|chat not found|message is too long|caption is too long|wrong file identifier|file is too big|not enough rights/.test(text)) {
    return 'permanent';
  }
  return 'unknown';
}

export async function runWithTelegramFailurePolicy(operation, options = {}) {
  const label = options.label || 'Telegram operation';
  const maxUnknownRetries = nonNegativeInteger(options.maxUnknownRetries, 3);
  const baseDelayMs = positiveNumber(options.baseDelayMs, 1_000);
  const maxDelayMs = positiveNumber(options.maxDelayMs, 60_000);
  const sleepFn = options.sleepFn || sleepWithSignal;
  let unknownRetries = 0;
  let networkRetries = 0;

  while (true) {
    try {
      return await operation({ attempt: unknownRetries + networkRetries + 1 });
    } catch (error) {
      const classification = classifyTelegramError(error);
      await options.onError?.({ error, classification, unknownRetries, networkRetries, label });

      if (classification === 'indeterminate' || classification === 'lease_lost' || classification === 'cancelled' || classification === 'permanent') {
        error.telegramFailureClass = classification;
        throw error;
      }

      if (classification === 'network') {
        networkRetries += 1;
        const delayMs = exponentialDelay(baseDelayMs, maxDelayMs, networkRetries);
        await options.onRetry?.({ error, classification, retry: networkRetries, delayMs, label });
        await sleepFn(delayMs, options.signal);
        continue;
      }

      if (unknownRetries >= maxUnknownRetries) {
        error.telegramFailureClass = 'unknown_exhausted';
        error.retryCount = unknownRetries;
        throw error;
      }

      unknownRetries += 1;
      const delayMs = exponentialDelay(baseDelayMs, maxDelayMs, unknownRetries);
      await options.onRetry?.({ error, classification, retry: unknownRetries, delayMs, label });
      await sleepFn(delayMs, options.signal);
    }
  }
}

function getStatusCode(error) {
  const values = [
    error?.response?.error_code,
    error?.response?.status,
    error?.status,
    error?.statusCode,
    error?.code
  ];
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }
  return 0;
}

function exponentialDelay(baseDelayMs, maxDelayMs, attempt) {
  const exponent = Math.min(10, Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
