import { formatPostCaption } from '../core/format.js';
import { withBotApiRetry } from './retry.js';

export async function sendRichPost({ telegram, chatId, mediaDownloader, post, index, templates }) {
  const files = await mediaDownloader.downloadPostMedia(post);
  try {
    const caption = formatPostCaption(post, index, templates);

    if (files.length === 0) {
      await withBotApiRetry(() => telegram.sendMessage(chatId, caption), { label: 'sendMessage' });
      return;
    }

    const [firstFile, ...extraFiles] = files;
    await sendSingleMedia({ telegram, chatId, file: firstFile, caption });

    for (const file of extraFiles) {
      await sendSingleMedia({ telegram, chatId, file });
    }
  } finally {
    await mediaDownloader.cleanupFiles?.(files);
  }
}

async function sendSingleMedia({ telegram, chatId, file, caption }) {
  if (file.kind === 'video') {
    await withBotApiRetry(
      () => telegram.sendVideo(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendVideo' }
    );
  } else {
    await withBotApiRetry(
      () => telegram.sendPhoto(chatId, { source: file.path }, caption ? { caption } : undefined),
      { label: 'sendPhoto' }
    );
  }
}
