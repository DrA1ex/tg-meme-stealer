import { formatPostCaption } from '../core/format.js';

export async function sendRichPost({ telegram, chatId, mediaDownloader, post, index, templates }) {
  const files = await mediaDownloader.downloadPostMedia(post);
  const caption = formatPostCaption(post, index, templates);

  if (files.length === 0) {
    await telegram.sendMessage(chatId, caption);
    return;
  }

  const [firstFile, ...extraFiles] = files;
  await sendSingleMedia({ telegram, chatId, file: firstFile, caption });

  for (const file of extraFiles) {
    await sendSingleMedia({ telegram, chatId, file });
  }
}

async function sendSingleMedia({ telegram, chatId, file, caption }) {
  if (file.kind === 'video') {
    await telegram.sendVideo(chatId, { source: file.path }, caption ? { caption } : undefined);
  } else {
    await telegram.sendPhoto(chatId, { source: file.path }, caption ? { caption } : undefined);
  }
}
