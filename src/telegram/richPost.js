import { formatPostCaption } from '../core/format.js';
import { getLogger } from '../core/logger.js';
import { withBotApiRetry } from './retry.js';

const logger = getLogger('richPost');

export async function sendRichPost({ telegram, chatId, mediaDownloader, post, index, templates, rateLimiter, operationTimeoutMs, signal, onBeforeSend }) {
  const files = await mediaDownloader.downloadPostMedia(post);
  let pendingOperation = null;
  try {
    const caption = formatPostCaption(post, index, templates);
    if (files.length === 0) {
      return withBotApiRetry(() => telegram.sendMessage(chatId, caption), {
        label: 'sendMessage', rateLimiter, chatId, operationTimeoutMs, signal, onBeforeOperation: onBeforeSend
      });
    }

    if (files.length > 1) {
      return await withBotApiRetry(
        () => telegram.sendMediaGroup(chatId, files.map((file, fileIndex) => ({
          type: file.kind === 'video' ? 'video' : 'photo',
          media: { source: file.path },
          ...(fileIndex === 0 ? { caption } : {})
        }))),
        { label: 'sendMediaGroup', rateLimiter, chatId, operationTimeoutMs, signal, onBeforeOperation: onBeforeSend }
      );
    }

    return await sendSingleMedia({
      telegram,
      chatId,
      file: files[0],
      caption,
      rateLimiter,
      operationTimeoutMs,
      signal,
      onBeforeOperation: onBeforeSend
    });
  } catch (error) {
    pendingOperation = getPendingTelegramOperation(error);
    throw error;
  } finally {
    if (pendingOperation) {
      scheduleCleanupAfterOperation(mediaDownloader, files, pendingOperation);
    } else {
      await mediaDownloader.cleanupFiles?.(files);
    }
  }
}

async function sendSingleMedia({ telegram, chatId, file, caption, rateLimiter, operationTimeoutMs, signal, onBeforeOperation }) {
  if (file.kind === 'video') {
    return withBotApiRetry(
      () => telegram.sendVideo(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendVideo', rateLimiter, chatId, operationTimeoutMs, signal, onBeforeOperation }
    );
  }
  return withBotApiRetry(
    () => telegram.sendPhoto(chatId, { source: file.path }, caption ? { caption } : undefined),
    { label: 'sendPhoto', rateLimiter, chatId, operationTimeoutMs, signal, onBeforeOperation }
  );
}

function getPendingTelegramOperation(error) {
  return error?.operationSettled && typeof error.operationSettled.then === 'function'
    ? error.operationSettled
    : null;
}

function scheduleCleanupAfterOperation(mediaDownloader, files, operationSettled) {
  void operationSettled
    .then(() => mediaDownloader.cleanupFiles?.(files))
    .catch((error) => {
      logger.warn('Deferred media cleanup failed', {
        files: files.length,
        error: error?.message || String(error)
      });
    });
}
