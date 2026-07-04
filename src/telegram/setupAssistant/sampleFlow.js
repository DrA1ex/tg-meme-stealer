import {
  DEFAULT_SAMPLE_MAX_MESSAGES,
  DEFAULT_SAMPLE_MIN_MATCHED,
  DEFAULT_SAMPLE_STEP_MESSAGES,
  DEFAULT_TEST_MESSAGES
} from './deps.js';
import {
  normalizeLoadMoreTarget,
  formatLoadMoreTarget,
  parseCachedSetupPosts,
  formatSampleProgress
} from './helpers.js';

export async function loadMoreMessages(ctx, target = '') {
  const normalizedTarget = normalizeLoadMoreTarget(target, this.getCurrentView(ctx));
  await this.collectSetupSample(ctx, {
    purpose: `load more for ${formatLoadMoreTarget(normalizedTarget)}`,
    includeMessages: true,
    forceLoadMore: true,
    minMatched: Number.POSITIVE_INFINITY
  });
  await this.showLoadMoreTarget(ctx, normalizedTarget);
}

export async function showLoadMoreTarget(ctx, target) {
  if (target === 'filters_options') return this.filterOptions(ctx);
  if (target === 'author_options') return this.authorOptions(ctx);
  if (target === 'reaction_options') return this.reactionOptions(ctx);
  if (target === 'filter_impact') return this.filterImpact(ctx);
  if (target === 'author_test') return this.authorTest(ctx);
  if (target === 'reaction_test') return this.reactionTest(ctx);
  if (target === 'parser_paths') return this.parserPaths(ctx);
  if (target === 'technical') return this.technicalDiagnostics(ctx);
  if (target === 'technical_field_scan') return this.technicalFieldScan(ctx);
  if (target === 'technical_shape') return this.technicalMessageShape(ctx);
  if (target === 'technical_reactions') return this.technicalReactionFields(ctx);
  if (target === 'technical_author') return this.technicalAuthorFields(ctx);
  if (target.startsWith('technical_trace:')) {
    const parts = target.slice('technical_trace:'.length).split(':');
    return this.technicalTrace(ctx, parts[0], Number(parts[1] || 0));
  }
  if (target.startsWith('technical_raw:')) {
    const parts = target.slice('technical_raw:'.length).split(':');
    return this.technicalRaw(ctx, parts[0], Number(parts[1] || 0));
  }
  if (target.startsWith('technical_preview_msg:')) {
    const parts = target.split(':');
    return this.technicalPreviewMessage(ctx, Number(parts[1] || 0), Number(parts[2] || 0));
  }
  if (target.startsWith('technical_msg:')) {
    const parts = target.split(':');
    return this.technicalViewMessage(ctx, Number(parts[1] || 0), Number(parts[2] || 0), parts[3] || 'overview');
  }
  if (target.startsWith('technical_preview')) return this.technicalMessageBrowser(ctx, Number(target.split(':')[1] || 0));
  if (target === 'test') return this.testDefaults(ctx);
  return this.suggestParser(ctx);
}

export async function refreshSample(ctx, target = '') {
  const normalizedTarget = normalizeLoadMoreTarget(target, this.getCurrentView(ctx));
  this.setupSampleCache.delete(ctx.from.id);
  await this.showLoadMoreTarget(ctx, normalizedTarget);
}

export async function collectSetupSample(ctx, {
  purpose = 'setup sample',
  initialLimit = DEFAULT_TEST_MESSAGES,
  minMatched = DEFAULT_SAMPLE_MIN_MATCHED,
  step = DEFAULT_SAMPLE_STEP_MESSAGES,
  maxLimit = DEFAULT_SAMPLE_MAX_MESSAGES,
  includeMessages = false,
  forceLoadMore = false
} = {}) {
  const draft = this.getDraft(ctx);
  const maxMessages = Math.max(1, Number(maxLimit || initialLimit || DEFAULT_TEST_MESSAGES));
  const cache = this.getUsableSampleCache(ctx, maxMessages);
  const cachedMessages = cache?.messages?.slice(0, maxMessages) || [];
  const targetInitialLimit = forceLoadMore && cachedMessages.length
                             ? Math.min(maxMessages, cachedMessages.length + Math.max(1, Number(step || DEFAULT_SAMPLE_STEP_MESSAGES)))
                             : initialLimit;
  const cachedPosts = cachedMessages.length ? parseCachedSetupPosts(cachedMessages, draft, this.config) : [];
  const cacheEnough = !forceLoadMore && cachedMessages.length > 0 && (
    cachedPosts.length >= minMatched ||
    cache.exhausted ||
    cachedMessages.length >= maxMessages ||
    !Number.isFinite(minMatched)
  );

  if (cacheEnough) {
    return {
      scanned: cachedMessages.length,
      posts: cachedPosts,
      pages: cache.pages || 0,
      exhausted: Boolean(cache.exhausted),
      fromCache: true,
      ...(includeMessages ? { messages: cachedMessages } : {})
    };
  }

  const progress = await ctx.reply(formatSampleProgress({
    purpose,
    scanned: cachedMessages.length,
    matched: cachedPosts.length,
    minMatched,
    maxLimit: maxMessages,
    status: cachedMessages.length ? 'using-cache' : 'starting'
  }));

  const editProgress = async (state) => {
    const text = formatSampleProgress({ purpose, ...state, status: 'loading' });
    await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, text).catch(() => {});
  };

  const result = await this.scanner.previewAdaptive({
    draft,
    initialLimit: targetInitialLimit,
    minMatched: forceLoadMore ? Number.POSITIVE_INFINITY : minMatched,
    step,
    maxLimit: maxMessages,
    includeMessages: true,
    seedMessages: cachedMessages,
    seedOffset: cache?.nextOffset,
    seedExhausted: cache?.exhausted,
    seedPages: cache?.pages,
    onProgress: editProgress
  });

  this.setupSampleCache.set(ctx.from.id, {
    messages: result.messages || [],
    nextOffset: result.nextOffset,
    exhausted: Boolean(result.exhausted),
    pages: result.pages || 0,
    loadedAt: Date.now()
  });

  await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, formatSampleProgress({
    purpose,
    scanned: result.scanned,
    matched: result.posts.length,
    minMatched,
    maxLimit: maxMessages,
    exhausted: result.exhausted,
    status: 'done'
  })).catch(() => {});

  return includeMessages ? result : { ...result, messages: undefined };
}

export function getSampleStatus(ctx, result = {}) {
  const cache = this.setupSampleCache.get(ctx.from.id);
  return {
    maxLimit: DEFAULT_SAMPLE_MAX_MESSAGES,
    exhausted: Boolean(result.exhausted ?? cache?.exhausted),
    cacheAgeMs: cache?.loadedAt ? Date.now() - Number(cache.loadedAt) : null
  };
}

export function getUsableSampleCache(ctx, maxMessages) {
  const cache = this.setupSampleCache.get(ctx.from.id);
  if (!cache?.messages?.length) return null;
  const maxAgeMs = 10 * 60 * 1000;
  if (Date.now() - Number(cache.loadedAt || 0) > maxAgeMs) {
    this.setupSampleCache.delete(ctx.from.id);
    return null;
  }
  if (Number(maxMessages || 0) <= 0) return null;
  return cache;
}

export const sampleFlowMethods = {
  loadMoreMessages,
  showLoadMoreTarget,
  refreshSample,
  collectSetupSample,
  getSampleStatus,
  getUsableSampleCache
};
