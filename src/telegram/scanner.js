import { debugParseMessage, parseMessagesToPosts } from '../core/postParser.js';
import { subtractDays } from '../core/date.js';
import { getLogger } from '../core/logger.js';
import { normalizeTelegramPeerId } from './peer.js';
import { withTelegramRetry } from './retry.js';
import { TelegramThrottle } from './throttle.js';
import { HistoryPageAssembler } from './historyAssembler.js';

export class TelegramScanner {
  constructor({ client, repository, config, throttle = new TelegramThrottle(config), signal = null }) {
    this.client = client;
    this.repository = repository;
    this.config = config;
    this.throttle = throttle;
    this.signal = signal;
    this.logger = getLogger('scanner');
  }

  async sync(options = {}) {
    return this.runSync(options);
  }

  async runSync(options = {}) {
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
    const reconciliation = await this.reconcileDeletedRecentPosts({
      sinceDate: subtractDays(now, this.config.sync.refreshRecentDays),
      seenIds: scan.seenIds,
      authoritativeComplete: scan.authoritativeComplete,
      force: Boolean(options.force || options.forceReconcile)
    });
    const deleted = reconciliation.deleted;

    this.logger.info('Sync finished', {
      initial: isInitial,
      pages: scan.pages,
      fetched: scan.fetched,
      matched: scan.matched,
      saved: scan.saved,
      skippedOld: scan.skippedOld,
      deleted,
      stopReason: scan.stopReason,
      reconciliationBlocked: reconciliation.blocked,
      missingRatio: reconciliation.missingRatio
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
      stopReason: scan.stopReason,
      authoritativeComplete: scan.authoritativeComplete,
      reconciliationBlocked: reconciliation.blocked,
      reconciliationReason: reconciliation.reason,
      expectedRecent: reconciliation.checked,
      missingRecent: reconciliation.missing,
      missingRatio: reconciliation.missingRatio,
      forcedReconciliation: reconciliation.forced
    };
  }

  async backfill(days = getInitialScanDays(this.config), options = {}) {
    return this.runBackfill(days, options);
  }

  async runBackfill(days = getInitialScanDays(this.config), options = {}) {
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
    const reconciliation = await this.reconcileDeletedRecentPosts({
      sinceDate: updateSince,
      seenIds: scan.seenIds,
      authoritativeComplete: scan.authoritativeComplete,
      force: Boolean(options.force || options.forceReconcile)
    });
    const deleted = reconciliation.deleted;

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
      stopReason: scan.stopReason,
      reconciliationBlocked: reconciliation.blocked,
      missingRatio: reconciliation.missingRatio
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
      stopReason: scan.stopReason,
      authoritativeComplete: scan.authoritativeComplete,
      reconciliationBlocked: reconciliation.blocked,
      reconciliationReason: reconciliation.reason,
      expectedRecent: reconciliation.checked,
      missingRecent: reconciliation.missing,
      missingRatio: reconciliation.missingRatio,
      forcedReconciliation: reconciliation.forced
    };
  }

  async scanSince(sinceDate) {
    const state = createScanState();
    const assembler = new HistoryPageAssembler();
    let offset;
    const seenCursors = new Set();
    const maxPages = Math.max(1, Number(this.config.sync.maxPagesPerRun) || 10_000);

    while (true) {
      state.pages += 1;
      assertPaginationProgress({ pages: state.pages, maxPages, offset, seenCursors, operation: 'sync' });
      const history = await this.getHistory({ limit: this.config.sync.pageSize, offset });
      const messages = [...history];
      state.fetched += messages.length;

      if (messages.length === 0) {
        state.stopReason = history.next ? 'unexpected-empty-page' : 'history-exhausted-empty';
        state.authoritativeComplete = !history.next;
        await this.processSyncMessages(assembler.flush(), sinceDate, state);
        this.logger[history.next ? 'warn' : 'debug']('History page returned no messages', {
          page: state.pages,
          hasNext: Boolean(history.next),
          stopReason: state.stopReason
        });
        break;
      }

      const oldestDate = getMessageDate(messages[messages.length - 1]);
      const reachedSince = oldestDate < sinceDate;
      const readyMessages = assembler.push(messages, { hasNext: Boolean(history.next) && !reachedSince });
      const pageStats = await this.processSyncMessages(readyMessages, sinceDate, state);
      this.logger.info('History page parsed', {
        page: state.pages,
        fetched: messages.length,
        matched: pageStats.matched,
        saved: pageStats.saved,
        skippedOld: pageStats.skippedOld,
        oldest: oldestDate.toISOString(),
        hasNext: Boolean(history.next)
      });

      if (reachedSince) {
        state.stopReason = 'reached-since-date';
        state.authoritativeComplete = true;
        break;
      }
      if (!history.next) {
        state.stopReason = 'history-exhausted';
        state.authoritativeComplete = true;
        break;
      }
      offset = history.next;
    }

    return state;
  }

  async processSyncMessages(messages, sinceDate, state) {
    if (!messages.length) return { matched: 0, saved: 0, skippedOld: 0 };
    const posts = parseMessagesToPosts(messages, {
      chatId: this.config.telegram.sourceChatId,
      parsing: this.config.parsing
    });
    state.matched += posts.length;
    let saved = 0;
    let skippedOld = 0;
    for (const post of posts) {
      if (new Date(post.messageDate) >= sinceDate) {
        await this.repository.upsertPost(post);
        state.seenIds.add(post.messageId);
        state.saved += 1;
        saved += 1;
      } else {
        state.skippedOld += 1;
        skippedOld += 1;
      }
    }
    return { matched: posts.length, saved, skippedOld };
  }

  async scanBackfill({ sinceDate, updateSinceDate, existingIds }) {
    const state = createBackfillState();
    const assembler = new HistoryPageAssembler();
    let offset;
    const seenCursors = new Set();
    const maxPages = Math.max(1, Number(this.config.sync.maxPagesPerRun) || 10_000);

    while (true) {
      state.pages += 1;
      assertPaginationProgress({ pages: state.pages, maxPages, offset, seenCursors, operation: 'backfill' });
      const history = await this.getHistory({ limit: this.config.sync.pageSize, offset });
      const messages = [...history];
      state.fetched += messages.length;

      if (messages.length === 0) {
        state.stopReason = history.next ? 'unexpected-empty-page' : 'history-exhausted-empty';
        state.authoritativeComplete = !history.next;
        await this.processBackfillMessages(assembler.flush(), { sinceDate, updateSinceDate, existingIds, state });
        this.logger[history.next ? 'warn' : 'debug']('Backfill history page returned no messages', {
          page: state.pages,
          hasNext: Boolean(history.next),
          stopReason: state.stopReason
        });
        break;
      }

      const oldestDate = getMessageDate(messages[messages.length - 1]);
      const reachedSince = oldestDate < sinceDate;
      const readyMessages = assembler.push(messages, { hasNext: Boolean(history.next) && !reachedSince });
      const pageStats = await this.processBackfillMessages(readyMessages, { sinceDate, updateSinceDate, existingIds, state });
      this.logger.info('Backfill page parsed', {
        page: state.pages,
        fetched: messages.length,
        matched: pageStats.matched,
        added: pageStats.added,
        updated: pageStats.updated,
        skippedExistingOld: pageStats.skippedExistingOld,
        skippedOld: pageStats.skippedOld,
        oldest: oldestDate.toISOString(),
        hasNext: Boolean(history.next)
      });

      if (reachedSince) {
        state.stopReason = 'reached-since-date';
        state.authoritativeComplete = true;
        break;
      }
      if (!history.next) {
        state.stopReason = 'history-exhausted';
        state.authoritativeComplete = true;
        break;
      }
      offset = history.next;
    }
    return state;
  }

  async processBackfillMessages(messages, { sinceDate, updateSinceDate, existingIds, state }) {
    if (!messages.length) return { matched: 0, added: 0, updated: 0, skippedExistingOld: 0, skippedOld: 0 };
    const posts = parseMessagesToPosts(messages, {
      chatId: this.config.telegram.sourceChatId,
      parsing: this.config.parsing
    });
    state.matched += posts.length;
    const page = { matched: posts.length, added: 0, updated: 0, skippedExistingOld: 0, skippedOld: 0 };
    for (const post of posts) {
      const action = getBackfillPostAction({ post, sinceDate, updateSinceDate, existingIds });
      if (action === 'skip-old') {
        state.skippedOld += 1;
        page.skippedOld += 1;
        continue;
      }
      state.seenIds.add(post.messageId);
      if (action === 'skip-existing-old') {
        state.skippedExistingOld += 1;
        page.skippedExistingOld += 1;
        continue;
      }
      await this.repository.upsertPost(post);
      existingIds.add(post.messageId);
      if (action === 'add') {
        state.added += 1;
        page.added += 1;
      } else {
        state.updated += 1;
        page.updated += 1;
      }
    }
    return page;
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
    const parsing = draft.parsing || this.config.parsing;
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
        const history = await this.getHistory({ limit: batchLimit, offset }, parsing);
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
        parsing
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

  async getMessageById(messageId, parsing = this.config.parsing) {
    const peerId = normalizeTelegramPeerId(this.config.telegram.sourceChatId);
    this.logger.info('Requesting message by id', { chatId: peerId, messageId });
    const messages = await withTelegramRetry(
      () => this.client.getMessages(peerId, [messageId]),
      { label: 'getMessages', rateLimiter: this.throttle, kind: 'media', signal: this.signal, indeterminateOnTimeout: false, indeterminateOnAbort: false }
    );
    await this.enrichMessagesWithNativeReactions(messages.filter(Boolean), parsing);
    return messages[0] || null;
  }

  async previewMessage(messageId, draft = {}) {
    const parsing = draft.parsing || this.config.parsing;
    const message = await this.getMessageById(messageId, parsing);
    if (!message) return { message: null, posts: [] };

    const posts = parseMessagesToPosts([message], {
      chatId: this.config.telegram.sourceChatId,
      parsing
    });

    return { message, posts };
  }

  async debugMessage(messageId, draft = {}) {
    const parsing = draft.parsing || this.config.parsing;
    const message = await this.getMessageById(messageId, parsing);
    if (!message) return { message: null, debug: null };

    return {
      message,
      debug: debugParseMessage(message, {
        chatId: this.config.telegram.sourceChatId,
        parsing
      })
    };
  }

  async reconcileDeletedRecentPosts({ sinceDate, seenIds, authoritativeComplete, force = false }) {
    const ids = await this.repository.listPostIdsSince(this.config.telegram.sourceChatId, sinceDate.toISOString());
    const missingRows = ids.filter((row) => !seenIds.has(row.messageId));
    const missingRatio = ids.length > 0 ? missingRows.length / ids.length : 0;
    const maxMissingRatio = Number(this.config.sync.maxMissingRatio ?? 0.3);

    if (!authoritativeComplete) {
      this.logger.warn('Deleted-post reconciliation skipped: history scan was incomplete', {
        checked: ids.length,
        missing: missingRows.length,
        missingRatio,
        since: sinceDate.toISOString()
      });
      return { deleted: 0, checked: ids.length, missing: missingRows.length, missingRatio, blocked: true, reason: 'incomplete_scan', forced: false };
    }
    if (!force && missingRatio > maxMissingRatio) {
      this.logger.warn('Deleted-post reconciliation blocked by missing-post safety threshold', {
        checked: ids.length,
        missing: missingRows.length,
        missingRatio,
        maxMissingRatio,
        since: sinceDate.toISOString()
      });
      return { deleted: 0, checked: ids.length, missing: missingRows.length, missingRatio, blocked: true, reason: 'missing_ratio_exceeded', forced: false };
    }

    let deleted = 0;
    for (const row of missingRows) {
      await this.repository.deletePost(this.config.telegram.sourceChatId, row.messageId);
      deleted += 1;
    }
    this.logger.info('Deleted-post reconciliation finished', {
      checked: ids.length,
      missing: missingRows.length,
      missingRatio,
      deleted,
      forced: force,
      since: sinceDate.toISOString()
    });
    return { deleted, checked: ids.length, missing: missingRows.length, missingRatio, blocked: false, reason: '', forced: force };
  }

  async removeDeletedRecentPosts(sinceDate, seenIds, options = {}) {
    const result = await this.reconcileDeletedRecentPosts({
      sinceDate,
      seenIds,
      authoritativeComplete: options.authoritativeComplete ?? true,
      force: Boolean(options.force)
    });
    return result.deleted;
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

  async enrichMessagesWithNativeReactions(messages = [], parsing = this.config.parsing) {
    if (!this.client || typeof this.client.getMessageReactions !== 'function') return messages;
    if (!needsNativeReactionEnrichment(parsing)) {
      this.logger.debug('Native reaction enrichment skipped', {
        messages: messages.length,
        reason: 'not_used_by_parser'
      });
      return messages;
    }
    const candidates = messages.filter((message) => message && hasReactionSummaryMarker(message) && !hasEnrichedNativeReactions(message));
    if (!candidates.length) return messages;

    try {
      this.logger.debug('Requesting native reactions batch', {
        messages: candidates.length
      });
      const reactionSummaries = await withTelegramRetry(
        () => this.client.getMessageReactions(candidates),
        { label: 'getMessageReactions', rateLimiter: this.throttle, kind: 'reactions', signal: this.signal, indeterminateOnTimeout: false, indeterminateOnAbort: false }
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
      this.logger.error('Failed to enrich required native reactions; synchronization is incomplete', {
        requested: candidates.length,
        error: error?.message || String(error)
      });
      const enrichmentError = new Error(`Native reaction enrichment failed for ${candidates.length} message(s): ${error?.message || String(error)}`, { cause: error });
      enrichmentError.code = 'NATIVE_REACTIONS_UNAVAILABLE';
      enrichmentError.telegramFailureScope = 'source';
      throw enrichmentError;
    }
    return messages;
  }

  async getHistory(params, parsing = this.config.parsing) {
    const peerId = normalizeTelegramPeerId(this.config.telegram.sourceChatId);
    this.logger.info('Requesting history', {
      chatId: peerId,
      limit: params.limit,
      hasOffset: Boolean(params.offset)
    });
    const history = await withTelegramRetry(
      () => this.client.getHistory(peerId, params),
      { label: 'getHistory', rateLimiter: this.throttle, kind: 'history', signal: this.signal, indeterminateOnTimeout: false, indeterminateOnAbort: false }
    );
    await this.enrichMessagesWithNativeReactions([...history], parsing);
    this.logger.debug('History request completed', { hasNext: Boolean(history.next) });
    return history;
  }
}

function createScanState() {
  return {
    seenIds: new Set(),
    pages: 0,
    fetched: 0,
    matched: 0,
    saved: 0,
    skippedOld: 0,
    stopReason: 'unknown',
    authoritativeComplete: false
  };
}

function createBackfillState() {
  return {
    ...createScanState(),
    added: 0,
    updated: 0,
    skippedExistingOld: 0
  };
}

const NATIVE_REACTION_PATH_PREFIXES = [
  'nativeReactions',
  'reactionCounts',
  'messageReactions',
  'reactions',
  'raw.reactions',
  'reaction_count'
];

export function needsNativeReactionEnrichment(parsing = {}) {
  return ['filters', 'author', 'likes', 'dislikes'].some((section) => (
    (parsing?.[section] || []).some(usesNativeReactionRule)
  ));
}

function usesNativeReactionRule(rule = {}) {
  if (rule.transform === 'reactionCount') return true;
  const path = String(rule.path || '').replaceAll('[]', '');
  return NATIVE_REACTION_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}


function assertPaginationProgress({ pages, maxPages, offset, seenCursors, operation }) {
  if (pages > maxPages) {
    const error = new Error(`${operation} pagination exceeded ${maxPages} pages`);
    error.code = 'TELEGRAM_PAGINATION_LIMIT';
    throw error;
  }
  if (offset === undefined || offset === null) return;
  const fingerprint = cursorFingerprint(offset);
  if (seenCursors.has(fingerprint)) {
    const error = new Error(`${operation} pagination cursor repeated; stopping to prevent an infinite loop`);
    error.code = 'TELEGRAM_PAGINATION_STALLED';
    throw error;
  }
  seenCursors.add(fingerprint);
}

function cursorFingerprint(value) {
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number' || typeof value === 'bigint') return `${typeof value}:${value}`;
  try {
    return `json:${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item)}`;
  } catch {
    return `string:${String(value)}`;
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
