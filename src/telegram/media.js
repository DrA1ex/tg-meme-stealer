import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';

export class MediaDownloader {
  constructor({ client, config, throttle = new TelegramThrottle(config) }) {
    this.client = client;
    this.config = config;
    this.throttle = throttle;
    this.logger = getLogger('media');
  }

  async downloadPostMedia(post) {
    const mediaDir = path.resolve(this.config.sync.mediaDir);
    await fs.mkdir(mediaDir, { recursive: true });
    const files = [];
    const mediaItems = post.data?.media || [];

    this.logger.info('Downloading post media', {
      chatId: post.chatId,
      messageId: post.messageId,
      mediaItems: mediaItems.length
    });

    for (const media of mediaItems) {
      const message = await this.loadMessage(post.chatId, media.messageId || post.messageId);
      if (!message?.media) continue;

      const buffer = await withTelegramRetry(
        () => this.client.downloadAsBuffer(message.media),
        { label: 'downloadAsBuffer', rateLimiter: this.throttle, kind: 'media' }
      );
      if (!buffer?.length) continue;

      const extension = media.mediaKind === 'video' ? 'mp4' : 'jpg';
      const filePath = path.join(mediaDir, `${post.chatId}_${post.messageId}_${media.messageId || post.messageId}.${extension}`);
      await fs.writeFile(filePath, buffer);
      files.push({ path: filePath, kind: media.mediaKind || 'photo' });
      this.logger.info('Media file downloaded', {
        chatId: post.chatId,
        messageId: media.messageId || post.messageId,
        kind: media.mediaKind || 'photo',
        bytes: buffer.length
      });
    }

    this.logger.info('Post media download finished', {
      chatId: post.chatId,
      messageId: post.messageId,
      files: files.length
    });

    return files;
  }

  async loadMessage(chatId, messageId) {
    this.logger.info('Requesting message', { chatId, messageId });
    const peerId = normalizeTelegramPeerId(chatId);
    const messages = await withTelegramRetry(
      () => this.client.getMessages(peerId, [messageId]),
      { label: 'getMessages', rateLimiter: this.throttle, kind: 'media' }
    );
    return messages[0] || null;
  }

  async cleanupFiles(files = []) {
    let deleted = 0;
    for (const file of files) {
      if (!file?.path) continue;
      try {
        await fs.unlink(file.path);
        deleted += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn('Failed to delete media file', { path: file.path, error: error.message });
        }
      }
    }
    if (deleted > 0) {
      this.logger.info('Temporary media files deleted', { files: deleted });
    }
    return deleted;
  }
}
