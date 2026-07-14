import { formatPostCaption } from '../core/format.js';
import { withBotApiRetry } from './retry.js';

export async function sendRichPost({ telegram, chatId, mediaDownloader, post, index, templates, rateLimiter, operationTimeoutMs, onBeforeSend }) {
  const files = await mediaDownloader.downloadPostMedia(post);
  try {
    const caption = formatPostCaption(post, index, templates);
    await onBeforeSend?.();

    if (files.length === 0) {
      return withBotApiRetry(() => telegram.sendMessage(chatId, caption), {
        label: 'sendMessage', rateLimiter, chatId, operationTimeoutMs
      });
    }

    const [firstFile, ...extraFiles] = files;
    const firstResult = await sendSingleMedia({ telegram, chatId, file: firstFile, caption, rateLimiter, operationTimeoutMs });

    for (const file of extraFiles) {
      await sendSingleMedia({ telegram, chatId, file, rateLimiter, operationTimeoutMs });
    }
    return firstResult;
  } finally {
    await mediaDownloader.cleanupFiles?.(files);
  }
}

async function sendSingleMedia({ telegram, chatId, file, caption, rateLimiter, operationTimeoutMs }) {
  if (file.kind === 'video') {
    return withBotApiRetry(
      () => telegram.sendVideo(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendVideo', rateLimiter, chatId, operationTimeoutMs }
    );
  } else {
    return withBotApiRetry(
      () => telegram.sendPhoto(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendPhoto', rateLimiter, chatId, operationTimeoutMs }
    );
  }
}
