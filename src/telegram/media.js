import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';

export class MediaDownloader {
  constructor({ client, config, throttle = new TelegramThrottle(config), signal = null, nowFn = Date.now }) {
    this.client = client;
    this.config = config;
    this.throttle = throttle;
    this.signal = signal;
    this.nowFn = nowFn;
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

    const portableFileIds = mediaItems.filter((item) => Boolean(item?.fileId)).length;
    const freshPortableFileIds = mediaItems.filter((item) => this.isPortableFileIdFresh(item)).length;
    this.logger.info('Downloading post media', {
      chatId: post.chatId,
      messageId: post.messageId,
      mediaItems: mediaItems.length,
      portableFileIds,
      freshPortableFileIds,
      attemptDir
    });

    try {
      // Telegram file references are deliberately short-lived. Legacy rows have no
      // capture timestamp, and old references should be refreshed before download
      // instead of producing one expected FILE_REFERENCE_EXPIRED error per post.
      const refreshLocationIds = [...new Set(mediaItems
        .filter((item) => !this.isPortableFileIdFresh(item))
        .map((item) => Number(item?.messageId || post.messageId))
        .filter(Number.isInteger))];
      const messagesById = refreshLocationIds.length
        ? await this.loadRefreshMessages(post.chatId, refreshLocationIds)
        : new Map();

      for (let index = 0; index < mediaItems.length; index += 1) {
        const media = mediaItems[index];
        const messageId = Number(media.messageId || post.messageId);
        const usePortableFileId = this.isPortableFileIdFresh(media);
        const message = messagesById.get(messageId) || null;
        let location = usePortableFileId ? media.fileId : message?.media;
        if (!location) throw new SourceMediaNotFoundError(post.chatId, messageId);
        if (!usePortableFileId) this.rememberPortableFileId(media, message?.media);

        const maxBytes = positiveNumber(this.config.sync?.mediaMaxBytes, 512 * 1024 * 1024);
        let declaredBytes = positiveNumber(media.fileSize, 0) || getDeclaredMediaSize(message?.media);
        if (declaredBytes > maxBytes) throw new MediaTooLargeError(declaredBytes, maxBytes);

        const kind = media.mediaKind || 'photo';
        const extension = kind === 'video' ? 'mp4' : 'jpg';
        const filePath = path.join(attemptDir, `${String(index + 1).padStart(2, '0')}-${randomCode()}.${extension}`);
        let bytes;
        try {
          bytes = await this.downloadToPath(location, filePath, maxBytes);
        } catch (error) {
          if (!usePortableFileId || !isFileReferenceError(error)) throw error;
          this.logger.info('Fresh media file reference expired early; refreshing it from source history', {
            chatId: post.chatId,
            messageId,
            capturedAt: media.fileIdCapturedAt,
            error: error?.message || String(error)
          });
          const refreshed = await this.loadMessageViaHistory(post.chatId, messageId);
          location = refreshed?.media;
          if (!location) throw new SourceMediaNotFoundError(post.chatId, messageId);
          this.rememberPortableFileId(media, location);
          declaredBytes = getDeclaredMediaSize(location);
          if (declaredBytes > maxBytes) throw new MediaTooLargeError(declaredBytes, maxBytes);
          bytes = await this.downloadToPath(location, filePath, maxBytes);
        }
        if (bytes === 0) throw new SourceMediaNotFoundError(post.chatId, messageId, 'Telegram returned an empty media stream');

        files.push({ path: filePath, kind, tempDir: attemptDir, bytes });
        this.logger.info('Media file downloaded', {
          chatId: post.chatId,
          messageId,
          kind,
          bytes,
          portableFileId: usePortableFileId
        });
      }

      this.logger.info('Post media download finished', {
        chatId: post.chatId,
        messageId: post.messageId,
        files: files.length
      });
      if (files.length === 0) await fs.rm(attemptDir, { recursive: true, force: true });
      return files;
    } catch (error) {
      if (error?.operationSettled && typeof error.operationSettled.then === 'function') {
        this.cleanupAttemptAfterOperation(attemptDir, error.operationSettled);
      } else {
        await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
  }

  isPortableFileIdFresh(media) {
    if (!media?.fileId) return false;
    const capturedAt = Date.parse(media.fileIdCapturedAt || '');
    if (!Number.isFinite(capturedAt)) return false;
    const maxAgeMs = positiveNumber(this.config.sync?.mediaFileIdMaxAgeHours, 6) * 60 * 60 * 1000;
    const ageMs = this.nowFn() - capturedAt;
    return ageMs >= -5 * 60 * 1000 && ageMs <= maxAgeMs;
  }

  rememberPortableFileId(media, location) {
    const fileId = getPortableMediaFileId(location);
    if (!fileId || !media) return;
    media.fileId = fileId;
    media.fileIdCapturedAt = new Date(this.nowFn()).toISOString();
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
      signal: this.signal,
      indeterminateOnTimeout: false,
      indeterminateOnAbort: false
    });
  }

  async loadRefreshMessages(chatId, messageIds) {
    const peerId = normalizeTelegramPeerId(chatId);
    if (typeof this.client.getHistory === 'function') {
      return this.loadMessagesViaHistory(peerId, messageIds);
    }
    return this.loadMessages(peerId, messageIds);
  }

  async loadMessages(chatId, messageIds) {
    const peerId = normalizeTelegramPeerId(chatId);
    this.logger.info('Requesting messages for legacy media references', { chatId: peerId, messageIds });
    try {
      const messages = await withTelegramRetry(
        () => this.client.getMessages(peerId, messageIds),
        { label: 'getMessages', rateLimiter: this.throttle, kind: 'media', signal: this.signal, indeterminateOnTimeout: false, indeterminateOnAbort: false }
      );
      return new Map(messages.filter(Boolean).map((message) => [Number(message.id), message]));
    } catch (error) {
      if (!isChannelResolutionError(error) || typeof this.client.getHistory !== 'function') {
        markSourcePeerError(error, chatId);
        throw error;
      }

      this.logger.warn('Direct channel message lookup failed; retrying through history', {
        chatId: peerId,
        messageIds,
        error: error?.message || String(error)
      });
      return this.loadMessagesViaHistory(peerId, messageIds);
    }
  }

  async loadMessagesViaHistory(peerId, messageIds) {
    const result = new Map();
    for (const messageId of messageIds) {
      try {
        const history = await withTelegramRetry(
          () => this.client.getHistory(peerId, {
            limit: 2,
            offset: { id: Number(messageId) + 1, date: 0 }
          }),
          { label: 'getHistoryForMedia', rateLimiter: this.throttle, kind: 'media', signal: this.signal, indeterminateOnTimeout: false, indeterminateOnAbort: false }
        );
        const message = [...history].find((item) => Number(item?.id) === Number(messageId));
        if (message) result.set(Number(messageId), message);
      } catch (error) {
        markSourcePeerError(error, peerId);
        throw error;
      }
    }
    return result;
  }

  async loadMessage(chatId, messageId) {
    const messages = await this.loadMessages(chatId, [messageId]);
    return messages.get(Number(messageId)) || null;
  }

  async loadMessageViaHistory(chatId, messageId) {
    const peerId = normalizeTelegramPeerId(chatId);
    const messages = await this.loadMessagesViaHistory(peerId, [Number(messageId)]);
    return messages.get(Number(messageId)) || null;
  }

  cleanupAttemptAfterOperation(attemptDir, operationSettled) {
    void Promise.resolve(operationSettled)
      .finally(() => fs.rm(attemptDir, { recursive: true, force: true }))
      .catch((error) => {
        this.logger.warn('Deferred media download cleanup failed', {
          path: attemptDir,
          error: error?.message || String(error)
        });
      });
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
    this.telegramFailureScope = 'post';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class SourceMediaNotFoundError extends Error {
  constructor(chatId, messageId, detail = 'Source message no longer contains downloadable media') {
    super(`${detail}: chat ${chatId}, message ${messageId}`);
    this.name = 'SourceMediaNotFoundError';
    this.code = 'SOURCE_MEDIA_NOT_FOUND';
    this.telegramFailureScope = 'post';
    this.chatId = chatId;
    this.messageId = messageId;
  }
}

function markSourcePeerError(error, chatId) {
  if (!error || typeof error !== 'object') return;
  error.telegramFailureScope = 'source';
  error.sourceChatId = chatId;
}

function isChannelResolutionError(error) {
  return /CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID|peer .*not found|not found in local cache/i.test(
    String(error?.message || error?.description || error)
  );
}


function isFileReferenceError(error) {
  return /FILE_REFERENCE_(?:EXPIRED|INVALID|EMPTY)|FILEREF_UPGRADE_NEEDED/i.test(
    String(error?.message || error?.description || error)
  );
}

function getPortableMediaFileId(media) {
  if (!media) return null;
  try {
    const value = media.fileId || media.file_id;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
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
