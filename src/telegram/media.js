import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';

export class MediaDownloader {
  constructor({ client, config, throttle = new TelegramThrottle(config), signal = null }) {
    this.client = client;
    this.config = config;
    this.throttle = throttle;
    this.signal = signal;
    this.logger = getLogger('media');
    this.staleCleanupPromise = null;
  }

  async downloadPostMedia(post) {
    const mediaDir = path.resolve(this.config.sync.mediaDir);
    await fs.mkdir(mediaDir, { recursive: true });
    await this.ensureStaleCleanup(mediaDir);
    const attemptDir = await fs.mkdtemp(path.join(mediaDir, 'publication-'));
    const files = [];
    const mediaItems = post.data?.media || [];

    this.logger.info('Downloading post media', {
      chatId: post.chatId,
      messageId: post.messageId,
      mediaItems: mediaItems.length,
      attemptDir
    });

    try {
      for (let index = 0; index < mediaItems.length; index += 1) {
        const media = mediaItems[index];
        const messageId = media.messageId || post.messageId;
        const message = await this.loadMessage(post.chatId, messageId);
        if (!message?.media) continue;

        const maxBytes = positiveNumber(this.config.sync?.mediaMaxBytes, 512 * 1024 * 1024);
        const declaredBytes = getDeclaredMediaSize(message.media);
        if (declaredBytes > maxBytes) throw new MediaTooLargeError(declaredBytes, maxBytes);

        const kind = media.mediaKind || 'photo';
        const extension = kind === 'video' ? 'mp4' : 'jpg';
        const filePath = path.join(attemptDir, `${String(index + 1).padStart(2, '0')}-${randomCode()}.${extension}`);
        const bytes = await this.downloadToPath(message.media, filePath, maxBytes);
        if (bytes === 0) {
          await fs.rm(filePath, { force: true });
          continue;
        }

        files.push({ path: filePath, kind, tempDir: attemptDir, bytes });
        this.logger.info('Media file downloaded', { chatId: post.chatId, messageId, kind, bytes });
      }

      this.logger.info('Post media download finished', {
        chatId: post.chatId,
        messageId: post.messageId,
        files: files.length
      });
      if (files.length === 0) await fs.rm(attemptDir, { recursive: true, force: true });
      return files;
    } catch (error) {
      await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async downloadToPath(location, filePath, maxBytes) {
    return withTelegramRetry(async () => {
      await fs.rm(filePath, { force: true });
      let bytes = 0;
      const sizeGuard = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(new MediaTooLargeError(bytes, maxBytes));
            return;
          }
          callback(null, chunk);
        }
      });
      const stream = this.client.downloadAsNodeStream(location, { abortSignal: this.signal });
      await pipeline(stream, sizeGuard, fsSync.createWriteStream(filePath, { flags: 'wx' }), { signal: this.signal || undefined });
      return bytes;
    }, {
      label: 'downloadAsNodeStream',
      rateLimiter: this.throttle,
      kind: 'media',
      signal: this.signal
    });
  }

  async loadMessage(chatId, messageId) {
    this.logger.info('Requesting message', { chatId, messageId });
    const peerId = normalizeTelegramPeerId(chatId);
    const messages = await withTelegramRetry(
      () => this.client.getMessages(peerId, [messageId]),
      { label: 'getMessages', rateLimiter: this.throttle, kind: 'media', signal: this.signal }
    );
    return messages[0] || null;
  }

  async cleanupFiles(files = []) {
    const directories = new Set();
    let deleted = 0;
    for (const file of files) {
      if (!file?.path) continue;
      if (file.tempDir) directories.add(file.tempDir);
      try {
        await fs.unlink(file.path);
        deleted += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn('Failed to delete media file', { path: file.path, error: error.message });
        }
      }
    }
    for (const directory of directories) {
      await fs.rm(directory, { recursive: true, force: true }).catch((error) => {
        this.logger.warn('Failed to delete media directory', { path: directory, error: error.message });
      });
    }
    if (deleted > 0) this.logger.info('Temporary media files deleted', { files: deleted, directories: directories.size });
    return deleted;
  }

  async cleanupStaleFiles(mediaDir = path.resolve(this.config.sync.mediaDir), now = Date.now()) {
    const maxAgeMs = positiveNumber(this.config.sync?.mediaMaxAgeHours, 24) * 60 * 60 * 1000;
    let entries;
    try {
      entries = await fs.readdir(mediaDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.name.startsWith('publication-')) continue;
      const entryPath = path.join(mediaDir, entry.name);
      try {
        const stat = await fs.stat(entryPath);
        if (now - stat.mtimeMs <= maxAgeMs) continue;
        await fs.rm(entryPath, { recursive: true, force: true });
        deleted += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') this.logger.warn('Failed to clean stale media path', { path: entryPath, error: error.message });
      }
    }
    if (deleted) this.logger.info('Stale temporary media cleaned', { paths: deleted, maxAgeMs });
    return deleted;
  }

  ensureStaleCleanup(mediaDir) {
    this.staleCleanupPromise ||= this.cleanupStaleFiles(mediaDir).catch((error) => {
      this.logger.warn('Stale media cleanup failed', { error: error?.message || String(error) });
      return 0;
    });
    return this.staleCleanupPromise;
  }
}

export class MediaTooLargeError extends Error {
  constructor(actualBytes, maxBytes) {
    super(`Media is too large: ${actualBytes} bytes exceeds configured limit ${maxBytes} bytes`);
    this.name = 'MediaTooLargeError';
    this.code = 'MEDIA_TOO_LARGE';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

function getDeclaredMediaSize(media) {
  const candidates = [
    media?.fileSize,
    media?.file_size,
    media?.size,
    media?.document?.size,
    media?.document?.fileSize,
    media?.photo?.size,
    media?.file?.size
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomCode() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
