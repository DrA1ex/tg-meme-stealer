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
  formatTechnicalDiagnosticsOverview,
  technicalDiagnosticsKeyboard,
  technicalDiagnosticsBackKeyboard,
  technicalTraceKeyboard,
  technicalRawKeyboard,
  technicalMessageBrowserKeyboard,
  technicalMessagePreviewKeyboard
} from './deps.js';
import {
  clampIndex,
  normalizeTechnicalTraceMode,
  normalizeTechnicalRawMode
} from './helpers.js';

export async function technicalDiagnostics(ctx) {
  this.rememberCurrentView(ctx, 'technical');
  const result = await this.collectSetupSample(ctx, { purpose: 'technical diagnostics', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatTechnicalDiagnosticsOverview({
    messages: result.messages || [],
    draft: this.getDraft(ctx),
    baseConfig: this.config,
    sample: this.getSampleStatus(ctx, result)
  }), technicalDiagnosticsKeyboard());
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
  const safePage = Math.max(0, Number(page || 0));
  this.rememberCurrentView(ctx, `technical_preview_msg:${messageId}:${safePage}`);
  const result = await this.collectSetupSample(ctx, { purpose: `message preview #${messageId}`, includeMessages: true });
  const message = (result.messages || []).find((item) => Number(item?.id || 0) === Number(messageId));
  const posts = message ? parseMessagesToPosts([message], { chatId: this.config.telegram?.sourceChatId, parsing: this.getDraft(ctx).parsing || this.config.parsing || {} }) : [];
  await this.replaceCurrentSetupMessage(
    ctx,
    formatTechnicalMessagePreview({ message, draft: this.getDraft(ctx), baseConfig: this.config }),
    technicalMessagePreviewKeyboard(safePage, messageId, posts.length > 0)
  );
}

export async function technicalSendPreviewMessage(ctx, messageId, page = 0) {
  const safePage = Math.max(0, Number(page || 0));
  const result = await this.collectSetupSample(ctx, { purpose: `single message preview #${messageId}`, includeMessages: true });
  const message = (result.messages || []).find((item) => Number(item?.id || 0) === Number(messageId));
  if (!message) {
    await this.replyWithKeyboard(ctx, `Message #${messageId} is not available in the loaded sample.`, technicalMessageBrowserKeyboard(result.messages || [], { page: safePage }));
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
    templates: this.getDraft(ctx).templates
  });
  await this.replyWithKeyboard(ctx, `Preview sent for message #${messageId}.`, technicalMessagePreviewKeyboard(safePage, messageId, true));
}

export const technicalFlowMethods = {
  technicalDiagnostics,
  technicalAction,
  technicalFieldScan,
  technicalMessageShape,
  technicalReactionFields,
  technicalAuthorFields,
  technicalTrace,
  technicalRaw,
  technicalMessageBrowser,
  technicalPreviewMessage,
  technicalSendPreviewMessage
};
