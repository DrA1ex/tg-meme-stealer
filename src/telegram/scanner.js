import { debugParseMessage, parseMessagesToPosts } from '../core/postParser.js';
import { subtractDays } from '../core/date.js';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';

export class TelegramScanner {
  constructor({ client, repository, config }) {
    this.client = client;
    this.repository = repository;
    this.config = config;
    this.throttle = new TelegramThrottle(config);
    this.logger = getLogger('scanner');
  }

  async sync() {
    return this.runSync();
  }

  async runSync() {
    const now = new Date();
    const existingCount = await this.repository.all('SELECT COUNT(*) AS count FROM posts WHERE chat_id = ?', [
      String(this.config.telegram.sourceChatId)
    ]);
    const isInitial = existingCount[0].count === 0;
    const since = isInitial
      ? subtractDays(now, getInitialScanDays(this.config))
      : subtractDays(now, this.config.sync.refreshRecentDays);

    this.logger.info('Sync started', {
      chatId: this.config.telegram.sourceChatId,
      initial: isInitial,
      existingPosts: existingCount[0].count,
      since: since.toISOString(),
      initialScanDays: getInitialScanDays(this.config),
      refreshRecentDays: this.config.sync.refreshRecentDays,
      pageSize: this.config.sync.pageSize
    });

    const scan = await this.scanSince(since);
    const deleted = await this.removeDeletedRecentPosts(subtractDays(now, this.config.sync.refreshRecentDays), scan.seenIds);

    this.logger.info('Sync finished', {
      initial: isInitial,
      pages: scan.pages,
      fetched: scan.fetched,
      matched: scan.matched,
      saved: scan.saved,
      skippedOld: scan.skippedOld,
      deleted,
      stopReason: scan.stopReason
    });

    return {
      isInitial,
      since: since.toISOString(),
      seen: scan.seenIds.size,
      pages: scan.pages,
      fetched: scan.fetched,
      matched: scan.matched,
      saved: scan.saved,
      skippedOld: scan.skippedOld,
      deleted,
      stopReason: scan.stopReason
    };
  }

  async backfill(days = getInitialScanDays(this.config)) {
    return this.runBackfill(days);
  }

  async runBackfill(days = getInitialScanDays(this.config)) {
    const now = new Date();
    const since = subtractDays(now, days);
    const updateSince = subtractDays(now, this.config.sync.refreshRecentDays);
    const existingRows = await this.repository.listPostIdsSince(this.config.telegram.sourceChatId, since.toISOString());
    const existingIds = new Set(existingRows.map((row) => row.messageId));

    this.logger.info('Backfill started', {
      chatId: this.config.telegram.sourceChatId,
      since: since.toISOString(),
      days,
      updateSince: updateSince.toISOString(),
      existingPostsInWindow: existingIds.size,
      pageSize: this.config.sync.pageSize
    });

    const scan = await this.scanBackfill({ sinceDate: since, updateSinceDate: updateSince, existingIds });
    const deleted = await this.removeDeletedRecentPosts(updateSince, scan.seenIds);

    this.logger.info('Backfill finished', {
      days,
      pages: scan.pages,
      fetched: scan.fetched,
      matched: scan.matched,
      added: scan.added,
      updated: scan.updated,
      skippedExistingOld: scan.skippedExistingOld,
      skippedOld: scan.skippedOld,
      deleted,
      stopReason: scan.stopReason
    });

    return {
      days,
      since: since.toISOString(),
      updateSince: updateSince.toISOString(),
      seen: scan.seenIds.size,
      pages: scan.pages,
      fetched: scan.fetched,
      matched: scan.matched,
      added: scan.added,
      updated: scan.updated,
      skippedExistingOld: scan.skippedExistingOld,
      skippedOld: scan.skippedOld,
      deleted,
      stopReason: scan.stopReason
    };
  }

  async scanSince(sinceDate) {
    const seenIds = new Set();
    let offset = undefined;
    let pages = 0;
    let fetched = 0;
    let matched = 0;
    let saved = 0;
    let skippedOld = 0;
    let stopReason = 'unknown';

    while (true) {
      pages += 1;
      const history = await this.getHistory({ limit: this.config.sync.pageSize, offset });

      const messages = [...history];
      fetched += messages.length;
      if (messages.length === 0) {
        stopReason = 'empty-page';
        this.logger.debug('History page returned no messages', { page: pages });
        break;
      }

      const posts = parseMessagesToPosts(messages, {
        chatId: this.config.telegram.sourceChatId,
        parsing: this.config.parsing
      });
      matched += posts.length;

      let pageSaved = 0;
      let pageSkippedOld = 0;
      for (const post of posts) {
        if (new Date(post.messageDate) >= sinceDate) {
          await this.repository.upsertPost(post);
          seenIds.add(post.messageId);
          saved += 1;
          pageSaved += 1;
        } else {
          skippedOld += 1;
          pageSkippedOld += 1;
        }
      }

      const oldest = messages[messages.length - 1];
      const oldestDate = getMessageDate(oldest);
      this.logger.info('History page parsed', {
        page: pages,
        fetched: messages.length,
        matched: posts.length,
        saved: pageSaved,
        skippedOld: pageSkippedOld,
        oldest: oldestDate.toISOString(),
        hasNext: Boolean(history.next)
      });

      if (oldestDate < sinceDate) {
        stopReason = 'reached-since-date';
        break;
      }
      if (!history.next) {
        stopReason = 'history-exhausted';
        break;
      }
      offset = history.next;
    }

    return { seenIds, pages, fetched, matched, saved, skippedOld, stopReason };
  }

  async scanBackfill({ sinceDate, updateSinceDate, existingIds }) {
    const seenIds = new Set();
    let offset = undefined;
    let pages = 0;
    let fetched = 0;
    let matched = 0;
    let added = 0;
    let updated = 0;
    let skippedExistingOld = 0;
    let skippedOld = 0;
    let stopReason = 'unknown';

    while (true) {
      pages += 1;
      const history = await this.getHistory({ limit: this.config.sync.pageSize, offset });
      const messages = [...history];
      fetched += messages.length;
      if (messages.length === 0) {
        stopReason = 'empty-page';
        this.logger.debug('Backfill history page returned no messages', { page: pages });
        break;
      }

      const posts = parseMessagesToPosts(messages, {
        chatId: this.config.telegram.sourceChatId,
        parsing: this.config.parsing
      });
      matched += posts.length;

      let pageAdded = 0;
      let pageUpdated = 0;
      let pageSkippedExistingOld = 0;
      let pageSkippedOld = 0;

      for (const post of posts) {
        const action = getBackfillPostAction({
          post,
          sinceDate,
          updateSinceDate,
          existingIds
        });

        if (action === 'skip-old') {
          skippedOld += 1;
          pageSkippedOld += 1;
          continue;
        }

        seenIds.add(post.messageId);

        if (action === 'skip-existing-old') {
          skippedExistingOld += 1;
          pageSkippedExistingOld += 1;
          continue;
        }

        await this.repository.upsertPost(post);
        existingIds.add(post.messageId);

        if (action === 'add') {
          added += 1;
          pageAdded += 1;
        } else {
          updated += 1;
          pageUpdated += 1;
        }
      }

      const oldest = messages[messages.length - 1];
      const oldestDate = getMessageDate(oldest);
      this.logger.info('Backfill page parsed', {
        page: pages,
        fetched: messages.length,
        matched: posts.length,
        added: pageAdded,
        updated: pageUpdated,
        skippedExistingOld: pageSkippedExistingOld,
        skippedOld: pageSkippedOld,
        oldest: oldestDate.toISOString(),
        hasNext: Boolean(history.next)
      });

      if (oldestDate < sinceDate) {
        stopReason = 'reached-since-date';
        break;
      }
      if (!history.next) {
        stopReason = 'history-exhausted';
        break;
      }
      offset = history.next;
    }

    return { seenIds, pages, fetched, matched, added, updated, skippedExistingOld, skippedOld, stopReason };
  }

  async previewRecent(limit = 30, draft = {}, options = {}) {
    const result = await this.previewAdaptive({
      draft,
      initialLimit: limit,
      minMatched: Number.POSITIVE_INFINITY,
      step: 0,
      maxLimit: limit,
      includeMessages: options.includeMessages
    });
    return result;
  }

  async previewAdaptive({
    draft = {},
    initialLimit = 40,
    minMatched = 30,
    step = 20,
    maxLimit = 160,
    includeMessages = false,
    onProgress = null,
    seedMessages = [],
    seedOffset = undefined,
    seedExhausted = false,
    seedPages = 0
  } = {}) {
    const messages = Array.isArray(seedMessages) ? [...seedMessages] : [];
    let offset = seedOffset;
    let pages = Number(seedPages || 0);
    let nextTarget = Math.max(1, Number(initialLimit || 40), messages.length);
    const maxMessages = Math.max(nextTarget, Number(maxLimit || nextTarget));
    const stepSize = Math.max(1, Number(step || 1));
    let posts = [];
    let exhausted = Boolean(seedExhausted);

    this.logger.info('Adaptive preview scan started', {
      initialLimit: nextTarget,
      minMatched,
      step: stepSize,
      maxLimit: maxMessages,
      seedMessages: messages.length,
      seedExhausted: exhausted
    });

    while (true) {
      while (!exhausted && messages.length < nextTarget && messages.length < maxMessages) {
        pages += 1;
        const batchLimit = Math.min(this.config.sync.pageSize, nextTarget - messages.length, maxMessages - messages.length);
        const history = await this.getHistory({ limit: batchLimit, offset });
        const batch = [...history];
        if (batch.length === 0) {
          exhausted = true;
          break;
        }
        messages.push(...batch);
        if (!history.next) exhausted = true;
        offset = history.next;
        if (exhausted) break;
      }

      posts = parseMessagesToPosts(messages, {
        chatId: this.config.telegram.sourceChatId,
        parsing: draft.parsing || this.config.parsing
      });

      if (typeof onProgress === 'function') {
        await onProgress({
          pages,
          scanned: messages.length,
          matched: posts.length,
          minMatched,
          maxLimit: maxMessages,
          exhausted
        });
      }

      if (posts.length >= minMatched || exhausted || messages.length >= maxMessages || !Number.isFinite(minMatched)) break;
      nextTarget = Math.min(maxMessages, messages.length + stepSize);
    }

    this.logger.info('Adaptive preview scan finished', {
      pages,
      scanned: messages.length,
      matched: posts.length,
      exhausted
    });

    return {
      scanned: messages.length,
      posts,
      pages,
      exhausted,
      nextOffset: offset,
      ...(includeMessages ? { messages } : {})
    };
  }

  async getMessageById(messageId) {
    const peerId = normalizeTelegramPeerId(this.config.telegram.sourceChatId);
    this.logger.info('Requesting message by id', { chatId: peerId, messageId });
    await this.throttle.wait('media');
    const messages = await withTelegramRetry(
      () => this.client.getMessages(peerId, [messageId]),
      { label: 'getMessages' }
    );
    await this.enrichMessagesWithNativeReactions(messages.filter(Boolean));
    return messages[0] || null;
  }

  async previewMessage(messageId, draft = {}) {
    const message = await this.getMessageById(messageId);
    if (!message) return { message: null, posts: [] };

    const posts = parseMessagesToPosts([message], {
      chatId: this.config.telegram.sourceChatId,
      parsing: draft.parsing || this.config.parsing
    });

    return { message, posts };
  }

  async debugMessage(messageId, draft = {}) {
    const message = await this.getMessageById(messageId);
    if (!message) return { message: null, debug: null };

    return {
      message,
      debug: debugParseMessage(message, {
        chatId: this.config.telegram.sourceChatId,
        parsing: draft.parsing || this.config.parsing
      })
    };
  }

  async removeDeletedRecentPosts(sinceDate, seenIds) {
    const ids = await this.repository.listPostIdsSince(this.config.telegram.sourceChatId, sinceDate.toISOString());
    let deleted = 0;
    for (const row of ids) {
      if (!seenIds.has(row.messageId)) {
        await this.repository.deletePost(this.config.telegram.sourceChatId, row.messageId);
        deleted += 1;
      }
    }
    this.logger.info('Deleted-post check finished', { checked: ids.length, deleted, since: sinceDate.toISOString() });
    return deleted;
  }

  async cleanupOldPosts(now = new Date()) {
    const retentionDays = getPostRetentionDays(this.config);
    const before = subtractDays(now, retentionDays);
    const pruned = await this.repository.deletePostsOlderThan(this.config.telegram.sourceChatId, before.toISOString());
    this.logger.info('Old-post cleanup finished', {
      retentionDays,
      before: before.toISOString(),
      pruned
    });
    return pruned;
  }

  async enrichMessagesWithNativeReactions(messages = []) {
    if (!this.client || typeof this.client.getMessageReactions !== 'function') return messages;
    const candidates = messages.filter((message) => message && hasReactionSummaryMarker(message) && !hasEnrichedNativeReactions(message));
    if (!candidates.length) return messages;

    try {
      const reactionSummaries = await withTelegramRetry(
        () => this.client.getMessageReactions(candidates),
        { label: 'getMessageReactions' }
      );

      for (let index = 0; index < candidates.length; index += 1) {
        const summary = reactionSummaries?.[index] || null;
        const reactions = extractMtcuteReactionRows(summary);
        if (!reactions.length) continue;
        candidates[index].messageReactions = summary;
        candidates[index].nativeReactions = reactions;
        candidates[index].reactionCounts = reactions;
      }

      this.logger.debug('Native reactions enriched', {
        requested: candidates.length,
        enriched: candidates.filter(hasEnrichedNativeReactions).length
      });
    } catch (error) {
      this.logger.warn('Failed to enrich native reactions', {
        requested: candidates.length,
        error: error.message
      });
    }
    return messages;
  }

  async getHistory(params) {
    const peerId = normalizeTelegramPeerId(this.config.telegram.sourceChatId);
    this.logger.info('Requesting history', {
      chatId: peerId,
      limit: params.limit,
      hasOffset: Boolean(params.offset)
    });
    await this.throttle.wait('history');
    const history = await withTelegramRetry(
      () => this.client.getHistory(peerId, params),
      { label: 'getHistory' }
    );
    await this.enrichMessagesWithNativeReactions([...history]);
    this.logger.debug('History request completed', { hasNext: Boolean(history.next) });
    return history;
  }
}


function hasReactionSummaryMarker(message) {
  return Boolean(message?.reactions || message?.raw?.reactions || message?.messageReactions);
}

function hasEnrichedNativeReactions(message) {
  return Array.isArray(message?.nativeReactions) || Array.isArray(message?.reactionCounts);
}

function extractMtcuteReactionRows(summary) {
  if (!summary) return [];
  if (Array.isArray(summary)) return summary;
  if (Array.isArray(summary.reactions)) return summary.reactions;
  if (Array.isArray(summary.results)) return summary.results;
  if (Array.isArray(summary.raw?.results)) return summary.raw.results;
  if (Array.isArray(summary.raw?.reactions)) return summary.raw.reactions;
  return [];
}

function getMessageDate(message) {
  if (message.date instanceof Date) return message.date;
  return new Date(Number(message.date) * 1000);
}

export function getInitialScanDays(config) {
  if (Number.isFinite(Number(config.sync?.initialScanDays))) {
    return Number(config.sync.initialScanDays);
  }
  return 60;
}

export function getPostRetentionDays(config) {
  return Math.max(1, Number(config.sync?.retentionDays ?? 60));
}

export function getBackfillPostAction({ post, sinceDate, updateSinceDate, existingIds }) {
  const messageDate = new Date(post.messageDate);
  if (messageDate < sinceDate) return 'skip-old';
  if (messageDate >= updateSinceDate) return existingIds.has(post.messageId) ? 'update' : 'add';
  return existingIds.has(post.messageId) ? 'skip-existing-old' : 'add';
}
