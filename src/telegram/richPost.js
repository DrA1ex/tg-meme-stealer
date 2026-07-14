import { formatPostCaption } from '../core/format.js';
import { withBotApiRetry } from './retry.js';

export async function sendRichPost({ telegram, chatId, mediaDownloader, post, index, templates, rateLimiter }) {
  const files = await mediaDownloader.downloadPostMedia(post);
  try {
    const caption = formatPostCaption(post, index, templates);

    if (files.length === 0) {
      return withBotApiRetry(() => telegram.sendMessage(chatId, caption), { label: 'sendMessage', rateLimiter, chatId });
    }

    const [firstFile, ...extraFiles] = files;
    const firstResult = await sendSingleMedia({ telegram, chatId, file: firstFile, caption, rateLimiter });

    for (const file of extraFiles) {
      await sendSingleMedia({ telegram, chatId, file, rateLimiter });
    }
    return firstResult;
  } finally {
    await mediaDownloader.cleanupFiles?.(files);
  }
}

async function sendSingleMedia({ telegram, chatId, file, caption, rateLimiter }) {
  if (file.kind === 'video') {
    return withBotApiRetry(
      () => telegram.sendVideo(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendVideo', rateLimiter, chatId }
    );
  } else {
    return withBotApiRetry(
      () => telegram.sendPhoto(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendPhoto', rateLimiter, chatId }
    );
  }
}
