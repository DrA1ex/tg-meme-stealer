import {
  parseMessagesToPosts,
  sendRichPost,
  findDiagnosticMessages,
  formatCompactRawMessageScreen,
  formatAuthorFields,
  formatFieldScan,
  formatMessageShape,
  formatMessageBrowser,
  formatParserTrace,
  formatReactionFields,
  formatTechnicalMessagePreview,
  formatSingleMessageOverview,
  formatSingleMessageRawReactions,
  formatSingleMessageShape,
  formatTechnicalDiagnosticsOverview,
  formatTechnicalRawToolsMenu,
  technicalDiagnosticsKeyboard,
  technicalDiagnosticsBackKeyboard,
  technicalTraceKeyboard,
  technicalRawKeyboard,
  technicalMessageBrowserKeyboard,
  technicalMessagePreviewKeyboard,
  technicalMessageViewKeyboard,
  technicalRawToolsKeyboard
} from './deps.js';
import {
  clampIndex,
  normalizeTechnicalTraceMode,
  normalizeTechnicalRawMode
} from './helpers.js';

export async function technicalDiagnostics(ctx) {
  this.rememberCurrentView(ctx, 'technical');
  const result = await this.collectSetupSample(ctx, { purpose: 'Diagnostics', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatTechnicalDiagnosticsOverview({
    messages: result.messages || [],
    draft: this.getDraft(ctx),
    baseConfig: this.config,
    sample: this.getSampleStatus(ctx, result)
  }), technicalDiagnosticsKeyboard());
}


export async function technicalRawTools(ctx) {
  this.rememberCurrentView(ctx, 'technical_raw_tools');
  await this.replyWithKeyboard(ctx, formatTechnicalRawToolsMenu(), technicalRawToolsKeyboard());
}

export async function technicalAction(ctx, action) {
  const target = String(action || '').replace(/^technical_/, '');
  if (target.startsWith('trace:')) {
    const parts = target.slice('trace:'.length).split(':');
    await this.technicalTrace(ctx, parts[0], Number(parts[1] || 0));
    return;
  }
  if (target.startsWith('raw:')) {
    const parts = target.slice('raw:'.length).split(':');
    await this.technicalRaw(ctx, parts[0], Number(parts[1] || 0));
    return;
  }
  if (target === 'preview_by_id' || target.startsWith('preview_by_id:')) {
    const explicitPage = target.includes(':') ? Number(target.split(':')[1] || 0) : null;
    await this.technicalMessageByIdPrompt(ctx, explicitPage);
    return;
  }
  if (target.startsWith('send_preview:')) {
    const [, messageId, page] = target.match(/^send_preview:(\d+):(\d+)$/) || [];
    await this.technicalSendPreviewMessage(ctx, Number(messageId || 0), Number(page || 0));
    return;
  }
  if (target.startsWith('preview_msg:')) {
    const [, messageId, page] = target.match(/^preview_msg:(\d+):(\d+)$/) || [];
    await this.technicalPreviewMessage(ctx, Number(messageId || 0), Number(page || 0));
    return;
  }
  if (target.startsWith('preview')) {
    const page = Number(target.split(':')[1] || 0);
    await this.technicalMessageBrowser(ctx, page);
    return;
  }
  const mapping = {
    field_scan: () => this.technicalFieldScan(ctx),
    shape: () => this.technicalMessageShape(ctx),
    reactions: () => this.technicalReactionFields(ctx),
    author: () => this.technicalAuthorFields(ctx)
  };
  const handler = mapping[target];
  if (handler) {
    await handler();
    return;
  }
  await this.technicalDiagnostics(ctx);
}

export async function technicalFieldScan(ctx) {
  this.rememberCurrentView(ctx, 'technical_field_scan');
  const result = await this.collectSetupSample(ctx, { purpose: 'field scan', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatFieldScan(result.messages || []), technicalDiagnosticsBackKeyboard('technical_field_scan'));
}

export async function technicalMessageShape(ctx) {
  this.rememberCurrentView(ctx, 'technical_shape');
  const result = await this.collectSetupSample(ctx, { purpose: 'message shape diagnostics', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatMessageShape(result.messages || []), technicalDiagnosticsBackKeyboard('technical_shape'));
}

export async function technicalReactionFields(ctx) {
  this.rememberCurrentView(ctx, 'technical_reactions');
  const result = await this.collectSetupSample(ctx, { purpose: 'reaction field diagnostics', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatReactionFields(result.messages || []), technicalDiagnosticsBackKeyboard('technical_reactions'));
}

export async function technicalAuthorFields(ctx) {
  this.rememberCurrentView(ctx, 'technical_author');
  const result = await this.collectSetupSample(ctx, { purpose: 'author field diagnostics', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatAuthorFields(result.messages || []), technicalDiagnosticsBackKeyboard('technical_author'));
}

export async function technicalTrace(ctx, mode = 'matched', index = 0) {
  const normalized = normalizeTechnicalTraceMode(mode);
  const result = await this.collectSetupSample(ctx, { purpose: `parser trace ${normalized}`, includeMessages: true });
  const matches = findDiagnosticMessages(result.messages || [], this.getDraft(ctx), this.config, normalized);
  const safeIndex = clampIndex(index, matches.length);
  this.rememberCurrentView(ctx, `technical_trace:${normalized}:${safeIndex}`);
  await this.replaceCurrentSetupMessage(ctx, formatParserTrace({
    messages: result.messages || [],
    draft: this.getDraft(ctx),
    baseConfig: this.config,
    mode: normalized,
    index: safeIndex
  }), technicalTraceKeyboard({ mode: normalized, index: safeIndex, total: matches.length }));
}

export async function technicalRaw(ctx, mode = 'matched', index = 0) {
  const normalized = normalizeTechnicalRawMode(mode);
  const result = await this.collectSetupSample(ctx, { purpose: `raw compact ${normalized}`, includeMessages: true });
  const matches = findDiagnosticMessages(result.messages || [], this.getDraft(ctx), this.config, normalized);
  const safeIndex = clampIndex(index, matches.length);
  this.rememberCurrentView(ctx, `technical_raw:${normalized}:${safeIndex}`);
  await this.replaceCurrentSetupMessage(ctx, formatCompactRawMessageScreen({
    messages: result.messages || [],
    draft: this.getDraft(ctx),
    baseConfig: this.config,
    mode: normalized,
    index: safeIndex
  }), technicalRawKeyboard({ mode: normalized, index: safeIndex, total: matches.length }), { parse_mode: 'HTML' });
}

export async function technicalMessageBrowser(ctx, page = 0) {
  const safePage = Math.max(0, Number(page || 0));
  this.rememberCurrentView(ctx, `technical_preview:${safePage}`);
  const result = await this.collectSetupSample(ctx, { purpose: `message browser page ${safePage + 1}`, includeMessages: true });
  const messages = result.messages || [];
  await this.replaceCurrentSetupMessage(
    ctx,
    formatMessageBrowser({ messages, draft: this.getDraft(ctx), baseConfig: this.config, page: safePage }),
    technicalMessageBrowserKeyboard(messages, { page: safePage })
  );
}

export async function technicalPreviewMessage(ctx, messageId, page = 0) {
  await this.technicalViewMessage(ctx, messageId, page, 'overview');
}

export async function technicalMessageByIdPrompt(ctx, page = null) {
  const currentView = this.getCurrentView(ctx);
  const currentPageMatch = String(currentView || '').match(/^technical_preview:(\d+)/);
  const resolvedPage = Math.max(0, Number.isFinite(Number(page)) && page !== null ? Number(page) : Number(currentPageMatch?.[1] || 0));
  this.setupTextPrompts.set(ctx.from.id, { kind: 'message_browser_id', page: resolvedPage });
  await this.replyWithKeyboard(
    ctx,
    'Send Telegram message id to inspect. I will look in the loaded setup sample first, then request it from Telegram if needed.',
    technicalMessageBrowserKeyboard(this.setupSampleCache.get(ctx.from.id)?.messages || [], { page: resolvedPage })
  );
}

export async function openTechnicalMessageByIdText(ctx, text, prompt = {}) {
  const messageId = Number(String(text || '').trim().replace(/^#/, ''));
  if (!Number.isFinite(messageId) || messageId <= 0) {
    await this.replyWithKeyboard(ctx, 'Message id must be a positive number. Send an id like 12345.', technicalMessageBrowserKeyboard(this.setupSampleCache.get(ctx.from.id)?.messages || [], { page: prompt.page || 0 }));
    return;
  }
  this.setupTextPrompts.delete(ctx.from.id);
  await this.technicalViewMessage(ctx, messageId, prompt.page || 0, 'overview');
}

export async function technicalViewMessage(ctx, messageId, page = 0, mode = 'overview') {
  const safePage = Math.max(0, Number(page || 0));
  const normalizedMode = ['overview', 'raw_reactions', 'shape'].includes(String(mode || '')) ? String(mode) : 'overview';
  const lookup = await this.resolveSetupMessageById(ctx, messageId);
  const message = lookup.message;
  const posts = message ? parseMessagesToPosts([message], { chatId: this.config.telegram?.sourceChatId, parsing: this.getDraft(ctx).parsing || this.config.parsing || {} }) : [];
  this.rememberCurrentView(ctx, `technical_msg:${messageId}:${safePage}:${normalizedMode}`);
  let text;
  let extra = {};
  if (!message) {
    text = formatMessageLookupMiss(lookup);
  } else if (normalizedMode === 'raw_reactions') {
    text = addLookupStatus(formatSingleMessageRawReactions({ message, draft: this.getDraft(ctx), baseConfig: this.config }), lookup);
    extra = { parse_mode: 'HTML' };
  } else if (normalizedMode === 'shape') {
    text = addLookupStatus(formatSingleMessageShape({ message, draft: this.getDraft(ctx), baseConfig: this.config }), lookup);
  } else {
    text = addLookupStatus(formatSingleMessageOverview({ message, draft: this.getDraft(ctx), baseConfig: this.config }), lookup);
  }
  const keyboard = technicalMessageViewKeyboard({ page: safePage, messageId, canPreview: posts.length > 0 });
  return this.replaceCurrentSetupMessage(ctx, text, keyboard, extra);
}

export async function resolveSetupMessageById(ctx, messageId) {
  const id = Number(messageId || 0);
  const cached = this.setupSampleCache.get(ctx.from.id)?.messages || [];
  const found = cached.find((message) => Number(message?.id || 0) === id);
  if (found) {
    return { id, message: found, source: 'loaded setup context', checkedContext: true, requestedTelegram: false };
  }

  if (typeof this.scanner?.getMessageById !== 'function') {
    return {
      id,
      message: null,
      source: 'not found',
      checkedContext: true,
      requestedTelegram: false,
      reason: 'Telegram source chat lookup is unavailable: scanner.getMessageById is not configured.'
    };
  }

  try {
    const message = await this.scanner.getMessageById(id);
    if (message) {
      const cache = this.setupSampleCache.get(ctx.from.id) || { messages: [], loadedAt: Date.now(), pages: 0 };
      if (!cache.messages.some((item) => Number(item?.id || 0) === id)) cache.messages.push(message);
      this.setupSampleCache.set(ctx.from.id, cache);
      return { id, message, source: 'Telegram source chat', checkedContext: true, requestedTelegram: true };
    }
    return {
      id,
      message: null,
      source: 'not found',
      checkedContext: true,
      requestedTelegram: true,
      reason: 'Telegram returned no message for this id.'
    };
  } catch (error) {
    return {
      id,
      message: null,
      source: 'lookup failed',
      checkedContext: true,
      requestedTelegram: true,
      reason: error?.message || String(error || 'Unknown Telegram lookup error')
    };
  }
}

export async function findSetupMessageById(ctx, messageId) {
  return (await this.resolveSetupMessageById(ctx, messageId)).message || null;
}

export async function technicalSendPreviewMessage(ctx, messageId, page = 0) {
  const safePage = Math.max(0, Number(page || 0));
  const lookup = await this.resolveSetupMessageById(ctx, messageId);
  const message = lookup.message;
  if (!message) {
    await this.replyWithKeyboard(
      ctx,
      ['Cannot send parsed preview for this message.', '', formatMessageLookupMiss(lookup)].join('\n'),
      technicalMessagePreviewKeyboard(safePage, messageId, false)
    );
    return;
  }
  const posts = parseMessagesToPosts([message], {
    chatId: this.config.telegram?.sourceChatId,
    parsing: this.getDraft(ctx).parsing || this.config.parsing || {}
  });
  if (!posts.length) {
    await this.replyWithKeyboard(ctx, `Message #${messageId} does not match current filters, so it cannot be previewed as a post.`, technicalMessagePreviewKeyboard(safePage, messageId, false));
    return;
  }
  await sendRichPost({
    telegram: ctx.telegram,
    chatId: ctx.chat.id,
    mediaDownloader: this.mediaDownloader,
    post: posts[0],
    index: 0,
    templates: this.getDraft(ctx).templates,
    rateLimiter: this.botRateLimiter
  });
  await this.replyWithKeyboard(ctx, `Preview sent for message #${messageId}.`, technicalMessagePreviewKeyboard(safePage, messageId, true));
}

function addLookupStatus(text, lookup = {}) {
  const status = formatLookupStatusLines(lookup);
  if (!status.length) return text;
  const lines = String(text || '').split('\n');
  const [title, ...rest] = lines;
  return [title, '', '🔎 Lookup', ...status, ...rest].join('\n');
}

function formatMessageLookupMiss(lookup = {}) {
  const status = formatLookupStatusLines(lookup);
  return [
    `🔍 Message lookup · #${Number(lookup.id || 0) || '?'}`,
    '',
    '🔎 Lookup',
    ...(status.length ? status : ['- Lookup did not run.']),
    '',
    '⚠️ Not found',
    lookup.reason ? `- ${lookup.reason}` : '- Message was not found.',
    '',
    '➡️ Next',
    '- Check that the id belongs to the configured source chat.',
    '- If the id is correct, Telegram may not expose that message to the userbot account.'
  ].join('\n');
}

function formatLookupStatusLines(lookup = {}) {
  const lines = [];
  if (lookup.checkedContext) {
    lines.push(lookup.source === 'loaded setup context'
      ? '- Loaded setup context: found.'
      : '- Loaded setup context: not found.');
  }
  if (lookup.requestedTelegram) {
    if (lookup.message) lines.push('- Telegram source chat: loaded by id.');
    else if (lookup.source === 'lookup failed') lines.push('- Telegram source chat: lookup failed.');
    else lines.push('- Telegram source chat: requested, not found.');
  } else if (lookup.source === 'loaded setup context') {
    lines.push('- Telegram source chat: not requested because context already had the message.');
  } else if (lookup.reason) {
    lines.push('- Telegram source chat: not requested.');
  }
  return lines;
}

export const technicalFlowMethods = {
  technicalDiagnostics,
  technicalRawTools,
  technicalAction,
  technicalFieldScan,
  technicalMessageShape,
  technicalReactionFields,
  technicalAuthorFields,
  technicalTrace,
  technicalRaw,
  technicalMessageBrowser,
  technicalPreviewMessage,
  technicalMessageByIdPrompt,
  openTechnicalMessageByIdText,
  technicalViewMessage,
  resolveSetupMessageById,
  findSetupMessageById,
  technicalSendPreviewMessage
};
