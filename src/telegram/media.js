import fs from 'node:fs/promises';
import path from 'node:path';

export class MediaDownloader {
  constructor({ client, config }) {
    this.client = client;
    this.config = config;
  }

  async downloadPostMedia(post) {
    const mediaDir = path.resolve(this.config.sync.mediaDir);
    await fs.mkdir(mediaDir, { recursive: true });
    const files = [];

    for (const media of post.data?.media || post.data?.images || []) {
      const message = await this.loadMessage(post.chatId, media.messageId || post.messageId);
      if (!message?.media) continue;

      const buffer = await this.client.downloadAsBuffer(message.media);
      if (!buffer?.length) continue;

      const extension = media.mediaKind === 'video' ? 'mp4' : 'jpg';
      const filePath = path.join(mediaDir, `${post.chatId}_${post.messageId}_${media.messageId || post.messageId}.${extension}`);
      await fs.writeFile(filePath, buffer);
      files.push({ path: filePath, kind: media.mediaKind || 'photo' });
    }

    return files;
  }

  async loadMessage(chatId, messageId) {
    const messages = await this.client.getMessages(chatId, [messageId]);
    return messages[0] || null;
  }
}
