export async function withTelegramRetry(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const label = options.label || 'telegram request';
  const sleepFn = options.sleepFn || sleep;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const waitSeconds = getFloodWaitSeconds(error);
      if (!waitSeconds || attempt === maxRetries) throw error;

      const waitMs = (waitSeconds + 1) * 1000;
      console.warn(`${label} hit FLOOD_WAIT_${waitSeconds}; retrying in ${waitSeconds + 1}s`);
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
      return await operation();
    } catch (error) {
      const retryAfter = getBotApiRetryAfterSeconds(error);
      if (!retryAfter || attempt === maxRetries) throw error;

      const waitMs = (retryAfter + 1) * 1000;
      console.warn(`${label} hit Too Many Requests; retrying in ${retryAfter + 1}s`);
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
