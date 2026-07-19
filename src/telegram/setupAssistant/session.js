import {
  createSetupDraft,
  formatDraftConfig,
  upsertPublishSource,
  validateSetupDraft,
  formatLastChange,
  formatNoLastChange,
  formatSetupIntro,
  formatSetupStatus,
  formatCheckAndSave,
  lastChangeKeyboard,
  checkAndSaveKeyboard,
  formatPublishChanges,
  parseCustomSourceInput,
  mergeReplyOptions,
  sourcesKeyboard,
  setupMenuKeyboard,
  replyJsonCode,
  createSetupMeta
} from './deps.js';

export async function start(ctx) {
  this.reloadConfig();
  this.sessions.set(ctx.from.id, createSetupDraft(this.config));
  this.setupMeta.set(ctx.from.id, createSetupMeta());
  this.setupLastChange.delete(ctx.from.id);
  this.setupTrafficPresets.delete(ctx.from.id);
  this.setupSampleCache.delete(ctx.from.id);
  this.setupCurrentView.delete(ctx.from.id);
  this.setupScheduleWizards.delete(ctx.from.id);
  this.setupTextPrompts.delete(ctx.from.id);
  await this.home(ctx);
}

export async function home(ctx) {
  await this.replyWithKeyboard(ctx, formatSetupIntro(this.getDraft(ctx), this.config, this.getMeta(ctx)), setupMenuKeyboard());
}

export async function status(ctx) {
  await this.replyWithKeyboard(ctx, formatSetupStatus(this.getDraft(ctx), this.config, this.getMeta(ctx)), checkAndSaveKeyboard());
}

export async function checkAndSave(ctx) {
  await this.replyWithKeyboard(ctx, formatCheckAndSave(this.getDraft(ctx), this.config, this.getMeta(ctx)), checkAndSaveKeyboard());
}

export async function done(ctx) {
  const userId = ctx.from.id;
  const activeSave = this.setupSaves.get(userId);
  if (activeSave) return activeSave;

  const operation = this.saveSetupSession(ctx);
  this.setupSaves.set(userId, operation);
  try {
    return await operation;
  } finally {
    if (this.setupSaves.get(userId) === operation) this.setupSaves.delete(userId);
  }
}

export async function saveSetupSession(ctx) {
  const draft = this.getDraft(ctx);
  if (!draft) return;

  // Disable stale Save buttons before asynchronous validation or filesystem work.
  await this.clearLastSetupKeyboard(ctx);
  validateSetupDraft(draft, this.config);
  const finalDraft = structuredClone(draft);
  const result = await this.saveDraft(finalDraft);

  // The durable side effect has completed. Close the setup session before any
  // Telegram confirmation calls so a delivery failure cannot make Save
  // repeatable from a stale button.
  this.clearSetupSessionState(ctx.from.id);
  this.reloadConfig();
  await ctx.reply([
    `Config saved: ${result.configPath}`,
    result.backupPath ? `Backup: ${result.backupPath}` : 'Backup: not needed (new config file)',
    '',
    'The running process still uses the previous configuration.',
    'Run /restart to apply the saved changes safely.',
    '',
    'Final config snippet:'
  ].join('\n'));
  await replyJsonCode(ctx, JSON.parse(formatDraftConfig(finalDraft)));
}

export async function cancel(ctx) {
  if (this.setupSaves.has(ctx.from.id)) {
    await ctx.reply('Setup config is being saved and cannot be cancelled now.');
    return;
  }

  this.clearSetupSessionState(ctx.from.id);
  await this.clearLastSetupKeyboard(ctx);
  await ctx.reply('Setup mode cancelled.');
}


export function clearSetupSessionState(userId) {
  this.sessions.delete(userId);
  this.setupSuggestions.delete(userId);
  this.setupMeta.delete(userId);
  this.setupLastChange.delete(userId);
  this.setupTrafficPresets.delete(userId);
  this.setupSampleCache.delete(userId);
  this.setupCurrentView.delete(userId);
  this.setupScheduleWizards.delete(userId);
  this.setupTextPrompts.delete(userId);
}

export async function handleSetupText(ctx) {
  if (!ctx?.from?.id || !this.sessions.has(ctx.from.id) || this.setupSaves.has(ctx.from.id)) return;
  const text = ctx.message?.text || '';
  if (text.startsWith('/')) return;
  const prompt = this.setupTextPrompts.get(ctx.from.id);
  if (!prompt) return;

  if (prompt.kind === 'message_browser_id') {
    await this.openTechnicalMessageByIdText(ctx, text, prompt);
    return;
  }

  if (prompt.kind === 'source_custom') {
    try {
      const source = parseCustomSourceInput(text);
      const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
      upsertPublishSource(this.getDraft(ctx), source);
      this.setupTextPrompts.delete(ctx.from.id);
      this.markChanged(ctx, 'publishing', `Custom source added: ${source.key}`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
      await this.replyWithKeyboard(ctx, `✅ Source added: ${source.key}\n${source.where}`, sourcesKeyboard(this.getDraft(ctx)));
    } catch (error) {
      await this.sourceCustomHelp(ctx, error.message);
    }
  }
}

export async function withSession(ctx, handler) {
  if (this.setupSaves.has(ctx.from.id)) {
    await ctx.reply('Setup config is being saved. Wait for the result before continuing.');
    return;
  }

  if (!this.sessions.has(ctx.from.id)) {
    await ctx.reply('Setup mode is not active. Run /setup first.');
    return;
  }

  try {
    await handler();
  } catch (error) {
    await this.replyWithKeyboard(ctx, `Setup error: ${error.message}`, setupMenuKeyboard());
  }
}

export async function replyWithKeyboard(ctx, text, keyboard, extra = {}) {
  await this.clearLastSetupKeyboard(ctx);
  const message = await ctx.reply(text, mergeReplyOptions(extra, keyboard));
  this.rememberSetupKeyboard(ctx, message);
  return message;
}

export async function replaceCurrentSetupMessage(ctx, text, keyboard, extra = {}) {
  const sourceMessage = ctx?.callbackQuery?.message;
  if (!sourceMessage?.message_id || !sourceMessage?.chat?.id) {
    return this.replyWithKeyboard(ctx, text, keyboard, extra);
  }
  try {
    await ctx.telegram.editMessageText(
      sourceMessage.chat.id,
      sourceMessage.message_id,
      undefined,
      text,
      mergeReplyOptions(extra, keyboard)
    );
    this.rememberSetupKeyboard(ctx, { message_id: sourceMessage.message_id, chat: sourceMessage.chat });
    return sourceMessage;
  } catch {
    return this.replyWithKeyboard(ctx, text, keyboard, extra);
  }
}

export async function clearLastSetupKeyboard(ctx) {
  const previous = this.setupMessages.get(ctx.from.id);
  if (!previous) return;
  this.setupMessages.delete(ctx.from.id);

  try {
    await ctx.telegram.editMessageReplyMarkup(
      previous.chatId,
      previous.messageId,
      undefined,
      { inline_keyboard: [] }
    );
  } catch {
    // The message can be too old, already edited, or deleted. This is only a UI cleanup.
  }
}

export function rememberSetupKeyboard(ctx, message) {
  if (!message?.message_id || !message?.chat?.id) return;
  this.setupMessages.set(ctx.from.id, {
    chatId: message.chat.id,
    messageId: message.message_id
  });
}

export function ensureSession(ctx) {
  if (this.sessions.has(ctx.from.id)) return;
  this.reloadConfig();
  this.sessions.set(ctx.from.id, createSetupDraft(this.config));
}

export function getDraft(ctx) {
  return this.sessions.get(ctx.from.id);
}

export function getMeta(ctx) {
  if (!this.setupMeta.has(ctx.from.id)) this.setupMeta.set(ctx.from.id, createSetupMeta());
  return this.setupMeta.get(ctx.from.id);
}

export function markChanged(ctx, area, title, detailLines = []) {
  const meta = this.getMeta(ctx);
  meta.changedAt = Date.now();
  meta.changedArea = area;
  meta.previewedAt = 0;
  meta.testedAt = area === 'parser' ? 0 : meta.testedAt;
  this.setupLastChange.set(ctx.from.id, {
    area,
    title,
    detailLines: Array.isArray(detailLines) ? detailLines : [String(detailLines)]
  });
}

export function markPreviewed(ctx) {
  this.getMeta(ctx).previewedAt = Date.now();
}

export function markTested(ctx) {
  this.getMeta(ctx).testedAt = Date.now();
}

export async function showLastChange(ctx) {
  const change = this.setupLastChange.get(ctx.from.id);
  if (!change) {
    await this.replyWithKeyboard(ctx, formatNoLastChange(), checkAndSaveKeyboard());
    return;
  }
  await this.replyWithKeyboard(ctx, formatLastChange(change), lastChangeKeyboard(change.area));
}

export function rememberCurrentView(ctx, view) {
  if (!ctx?.from?.id || !view) return;
  this.setupCurrentView.set(ctx.from.id, view);
}

export function getCurrentView(ctx) {
  return this.setupCurrentView.get(ctx.from.id) || 'suggest';
}

export function reloadConfig() {
  this.config = structuredClone(this.configLoader());
}

export const sessionMethods = {
  start,
  home,
  status,
  checkAndSave,
  done,
  saveSetupSession,
  cancel,
  clearSetupSessionState,
  handleSetupText,
  withSession,
  replyWithKeyboard,
  replaceCurrentSetupMessage,
  clearLastSetupKeyboard,
  rememberSetupKeyboard,
  ensureSession,
  getDraft,
  getMeta,
  markChanged,
  markPreviewed,
  markTested,
  showLastChange,
  rememberCurrentView,
  getCurrentView,
  reloadConfig
};
