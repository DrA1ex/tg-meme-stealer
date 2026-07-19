import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';

const HISTORY_BATCH_LIMIT = 100;

export class MediaDownloader {
  constructor({ client, config, throttle = new TelegramThrottle(config), signal = null }) {
    this.client = client;
    this.config = config;
    this.throttle = throttle;
    this.signal = signal;
    this.logger = getLogger('media');
    this.staleCleanupPromise = null;
    this.directMessageLookupDisabledPeers = new Set();
  }

  async preparePublicationMediaContext(posts, { source = 'scheduled-publication' } = {}) {
    const idsByChat = collectMediaMessageIdsByChat(posts);
    const sourceMessagesByChatId = new Map();
    let requestedMessages = 0;
    let loadedMessages = 0;

    for (const [chatKey, group] of idsByChat) {
      requestedMessages += group.messageIds.length;
      const messages = await this.loadMessagesBatched(group.chatId, group.messageIds);
      loadedMessages += messages.size;
      sourceMessagesByChatId.set(chatKey, messages);
    }

    if (requestedMessages > 0) {
      this.logger.info('Prepared source media messages for publication', {
        source,
        chats: idsByChat.size,
        requestedMessages,
        loadedMessages,
        missingMessages: requestedMessages - loadedMessages
      });
    }

    return {
      source,
      sourceMessagesByChatId,
      sourceMessagesComplete: true
    };
  }

  async downloadPostMedia(post, options = {}) {
    const mediaDir = path.resolve(this.config.sync.mediaDir);
    await fs.mkdir(mediaDir, { recursive: true });
    await this.ensureStaleCleanup(mediaDir);
    const attemptDir = await fs.mkdtemp(path.join(mediaDir, 'publication-'));
    const files = [];
    const mediaItems = post.data?.media || [];
    const messagesById = getProvidedMessagesForChat(options, post.chatId);
    const messageIds = collectPostMediaMessageIds(post, mediaItems);
    const missingIds = messageIds.filter((messageId) => !messagesById.has(messageId));

    if (missingIds.length > 0 && options?.sourceMessagesComplete !== true) {
      const loaded = await this.loadMessagesBatched(post.chatId, missingIds);
      for (const [messageId, message] of loaded) messagesById.set(messageId, message);
    }

    this.logger.info('Downloading post media', {
      chatId: post.chatId,
      messageId: post.messageId,
      mediaItems: mediaItems.length,
      providedMessages: messagesById.size,
      missingMessages: messageIds.filter((messageId) => !messagesById.has(messageId)).length,
      source: String(options?.source || 'history'),
      attemptDir
    });

    try {
      for (let index = 0; index < mediaItems.length; index += 1) {
        const media = mediaItems[index];
        const messageId = Number(media.messageId || post.messageId);
        const message = messagesById.get(messageId) || null;
        let location = message?.media;
        if (!location) throw new SourceMediaNotFoundError(post.chatId, messageId);

        const maxBytes = positiveNumber(this.config.sync?.mediaMaxBytes, 512 * 1024 * 1024);
        let declaredBytes = positiveNumber(media.fileSize, 0) || getDeclaredMediaSize(location);
        if (declaredBytes > maxBytes) throw new MediaTooLargeError(declaredBytes, maxBytes);

        const kind = media.mediaKind || 'photo';
        const extension = kind === 'video' ? 'mp4' : 'jpg';
        const filePath = path.join(attemptDir, `${String(index + 1).padStart(2, '0')}-${randomCode()}.${extension}`);
        let bytes;
        try {
          bytes = await this.downloadToPath(location, filePath, maxBytes);
        } catch (error) {
          if (!isFileReferenceError(error)) throw error;
          this.logger.error('Media file reference expired after source message lookup; refreshing once', {
            errorCode: 'FILE_REFERENCE_EXPIRED',
            chatId: post.chatId,
            messageId,
            source: String(options?.source || 'history'),
            error: error?.message || String(error)
          });
          const refreshed = await this.loadMessageViaHistory(post.chatId, messageId);
          location = refreshed?.media;
          if (!location) throw new SourceMediaNotFoundError(post.chatId, messageId);
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
          locationSource: String(options?.source || 'history')
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

  async loadMessagesBatched(chatId, messageIds) {
    const peerId = normalizeTelegramPeerId(chatId);
    const ids = normalizeMessageIds(messageIds);
    if (ids.length === 0) return new Map();

    const peerKey = normalizeChatKey(peerId);
    if (typeof this.client.getMessages === 'function' && !this.directMessageLookupDisabledPeers.has(peerKey)) {
      try {
        return await this.loadMessagesViaDirectLookup(peerId, ids);
      } catch (error) {
        if (!isDirectMessageLookupPeerError(error)) {
          markSourcePeerError(error, peerId);
          throw error;
        }

        const recovered = await this.retryDirectLookupAfterPeerRefresh(peerId, ids, error);
        if (recovered) return recovered;

        this.directMessageLookupDisabledPeers.add(peerKey);
        this.logger.warn('Direct source message lookup disabled for peer; using history fallback', {
          chatId: peerId,
          messageIds: ids.length,
          error: error?.message || String(error)
        });
      }
    }

    return this.loadMessagesViaHistoryBatched(peerId, ids);
  }

  async loadMessagesViaDirectLookup(peerId, messageIds) {
    const result = new Map();
    for (const ids of chunkMessageIds(messageIds, HISTORY_BATCH_LIMIT)) {
      const messages = await withTelegramRetry(
        () => this.client.getMessages(peerId, ids),
        {
          label: 'getMessagesForMedia',
          rateLimiter: this.throttle,
          kind: 'media',
          signal: this.signal,
          indeterminateOnTimeout: false,
          indeterminateOnAbort: false
        }
      );
      for (const [messageId, message] of mapRequestedMessages(ids, messages)) result.set(messageId, message);
    }
    return result;
  }

  async retryDirectLookupAfterPeerRefresh(peerId, messageIds, originalError) {
    if (typeof this.client.resolvePeer !== 'function') return null;
    try {
      await withTelegramRetry(
        () => this.client.resolvePeer(peerId, true),
        {
          label: 'resolvePeerForMedia',
          rateLimiter: this.throttle,
          kind: 'media',
          signal: this.signal,
          indeterminateOnTimeout: false,
          indeterminateOnAbort: false
        }
      );
      return await this.loadMessagesViaDirectLookup(peerId, messageIds);
    } catch (error) {
      if (!isDirectMessageLookupPeerError(error)) {
        markSourcePeerError(error, peerId);
        throw error;
      }
      this.logger.warn('Direct source message lookup still unavailable after peer refresh', {
        chatId: peerId,
        messageIds: messageIds.length,
        initialError: originalError?.message || String(originalError),
        error: error?.message || String(error)
      });
      return null;
    }
  }

  async loadMessagesViaHistoryBatched(chatId, messageIds) {
    const peerId = normalizeTelegramPeerId(chatId);
    const ids = normalizeMessageIds(messageIds);
    const result = new Map();

    for (const batch of buildHistoryBatches(ids)) {
      const wanted = new Set(batch.messageIds);
      let offsetId = batch.maxId + 1;
      let authoritative = false;
      let pages = 0;

      while (!authoritative && pages < HISTORY_BATCH_LIMIT) {
        pages += 1;
        const limit = Math.max(2, Math.min(HISTORY_BATCH_LIMIT, offsetId - batch.minId));
        const history = await this.getHistoryForMedia(peerId, {
          limit,
          offset: { id: offsetId, date: 0 }
        });
        const normalized = [...(history || [])].filter((message) => Number.isInteger(Number(message?.id)));
        for (const message of normalized) {
          const messageId = Number(message.id);
          if (wanted.has(messageId)) result.set(messageId, message);
        }

        if (normalized.length === 0) {
          authoritative = true;
          break;
        }
        const lowestId = Math.min(...normalized.map((message) => Number(message.id)));
        if (lowestId <= batch.minId) {
          authoritative = true;
          break;
        }
        if (lowestId >= offsetId) {
          const error = new Error(`Source history pagination did not advance for chat ${peerId}`);
          error.code = 'SOURCE_HISTORY_STALLED';
          markSourcePeerError(error, peerId);
          throw error;
        }
        offsetId = lowestId;
      }

      if (!authoritative) {
        const error = new Error(`Source history range could not be completed for chat ${peerId}`);
        error.code = 'SOURCE_HISTORY_INCOMPLETE';
        markSourcePeerError(error, peerId);
        throw error;
      }
    }

    return result;
  }

  async getHistoryForMedia(peerId, params) {
    try {
      return await withTelegramRetry(
        () => this.client.getHistory(peerId, params),
        {
          label: 'getHistoryForMedia',
          rateLimiter: this.throttle,
          kind: 'media',
          signal: this.signal,
          indeterminateOnTimeout: false,
          indeterminateOnAbort: false
        }
      );
    } catch (error) {
      markSourcePeerError(error, peerId);
      throw error;
    }
  }

  async loadMessage(chatId, messageId) {
    return this.loadMessageViaHistory(chatId, messageId);
  }

  async loadMessageViaHistory(chatId, messageId) {
    const peerId = normalizeTelegramPeerId(chatId);
    const history = await this.getHistoryForMedia(peerId, {
      limit: 2,
      offset: { id: Number(messageId) + 1, date: 0 }
    });
    return [...(history || [])].find((item) => Number(item?.id) === Number(messageId)) || null;
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

function isFileReferenceError(error) {
  return /FILE_REFERENCE_(?:EXPIRED|INVALID|EMPTY)|FILEREF_UPGRADE_NEEDED/i.test(
    String(error?.message || error?.description || error)
  );
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

function collectMediaMessageIdsByChat(posts = []) {
  const result = new Map();
  for (const post of posts || []) {
    const mediaItems = post?.data?.media || [];
    if (mediaItems.length === 0) continue;
    const chatId = post.chatId;
    const chatKey = normalizeChatKey(chatId);
    const current = result.get(chatKey) || { chatId, ids: new Set() };
    for (const messageId of collectPostMediaMessageIds(post, mediaItems)) current.ids.add(messageId);
    result.set(chatKey, current);
  }
  return new Map([...result.entries()].map(([chatKey, group]) => [chatKey, {
    chatId: group.chatId,
    messageIds: [...group.ids].sort((a, b) => b - a)
  }]));
}

function collectPostMediaMessageIds(post, mediaItems = post?.data?.media || []) {
  return normalizeMessageIds(mediaItems.map((media) => Number(media?.messageId || post?.messageId)));
}

function buildHistoryBatches(messageIds) {
  const batches = [];
  let current = [];
  for (const messageId of normalizeMessageIds(messageIds)) {
    if (current.length === 0) {
      current.push(messageId);
      continue;
    }
    const maxId = current[0];
    if (current.length < HISTORY_BATCH_LIMIT && maxId - messageId < HISTORY_BATCH_LIMIT) {
      current.push(messageId);
      continue;
    }
    batches.push(createHistoryBatch(current));
    current = [messageId];
  }
  if (current.length > 0) batches.push(createHistoryBatch(current));
  return batches;
}

function createHistoryBatch(messageIds) {
  const maxId = messageIds[0];
  const minId = messageIds.at(-1);
  return {
    maxId,
    minId,
    messageIds: [...messageIds],
    limit: Math.max(2, Math.min(HISTORY_BATCH_LIMIT, maxId - minId + 1))
  };
}

function getProvidedMessagesForChat(options, chatId) {
  const chatKey = normalizeChatKey(chatId);
  const byChat = options?.sourceMessagesByChatId;
  if (byChat instanceof Map) {
    return normalizeMessageMap(byChat.get(chatKey) ?? byChat.get(chatId) ?? byChat.get(String(chatId)));
  }
  if (byChat && typeof byChat === 'object') {
    return normalizeMessageMap(byChat[chatKey] ?? byChat[chatId] ?? byChat[String(chatId)]);
  }
  return normalizeMessageMap(options?.sourceMessagesById);
}

function normalizeMessageMap(value) {
  if (value instanceof Map) {
    return new Map([...value.entries()]
      .map(([messageId, message]) => [Number(messageId), message])
      .filter(([messageId, message]) => Number.isInteger(messageId) && message));
  }
  if (!value || typeof value !== 'object') return new Map();
  return new Map(Object.entries(value)
    .map(([messageId, message]) => [Number(messageId), message])
    .filter(([messageId, message]) => Number.isInteger(messageId) && message));
}

function normalizeMessageIds(values) {
  return [...new Set((values || [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => b - a);
}

function chunkMessageIds(messageIds, limit) {
  const ids = normalizeMessageIds(messageIds);
  const chunks = [];
  for (let index = 0; index < ids.length; index += limit) chunks.push(ids.slice(index, index + limit));
  return chunks;
}

function mapRequestedMessages(messageIds, messages) {
  const wanted = new Set(normalizeMessageIds(messageIds));
  const result = new Map();
  for (const [index, message] of [...(messages || [])].entries()) {
    if (!message) continue;
    const messageId = Number(message?.id ?? messageIds[index]);
    if (wanted.has(messageId)) result.set(messageId, message);
  }
  return result;
}

function isDirectMessageLookupPeerError(error) {
  const value = [error?.name, error?.code, error?.errorMessage, error?.message, error?.description]
    .filter(Boolean)
    .join(' ');
  return /CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|MtPeerNotFoundError|peer .*not found in local cache/i.test(value);
}

function normalizeChatKey(chatId) {
  return String(normalizeTelegramPeerId(chatId));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomCode() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
