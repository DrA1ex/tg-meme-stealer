import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPosts,
  setPublishSources,
  setPublishTemplate,
  upsertPublishSource,
  setParsingRules,
  setTemplateValue,
  summarizeParsedPosts,
  validateSetupDraft
} from '../core/setupConfig.js';
import { loadConfig } from '../config/index.js';
import { sendRichPost } from './richPost.js';
import { ADVANCED_HELP, DEFAULT_PREVIEW_MESSAGES, DEFAULT_PREVIEW_POSTS, DEFAULT_TEST_MESSAGES } from './setup/constants.js';
import {
  formatConfirmResetFilters,
  formatLastChange,
  formatNoLastChange,
  formatParserMenu,
  formatPublishMenu,
  formatSetupDoctor,
  formatSetupIntro,
  formatSetupStatus,
  lastChangeKeyboard
} from './setup/messages.js';
import {
  buildParserSuggestions,
  formatAppliedSuggestion,
  formatNoopSuggestion,
  formatParserChanges,
  formatParserSuggestions,
  formatFiltersReset,
  confirmResetFiltersKeyboard,
  isSuggestionUseful,
  markSuggestionStates,
  parserSuggestionsKeyboard
} from './setup/parserSuggestions.js';
import {
  applyPublishPresetToDraft,
  formatAppliedPublishPreset,
  formatConfirmReplacePublishPreset,
  formatPublishChanges,
  formatPublishPresetDetails,
  formatPublishPresetsMenu,
  getPublishPreset
} from './setup/publishPresets.js';
import {
  advancedMenuKeyboard,
  confirmReplacePublishPresetKeyboard,
  mergeReplyOptions,
  parserMenuKeyboard,
  previewMenuKeyboard,
  publishAfterPresetKeyboard,
  publishMenuKeyboard,
  publishPresetDetailsKeyboard,
  publishPresetsKeyboard,
  setupMenuKeyboard
} from './setup/keyboards.js';
import {
  getArgument,
  parseLimit,
  parseMessageId,
  parsePreviewArgs,
  replyCode,
  replyJsonCode,
  replyJsonFile,
  replaceObjectContents,
  splitFirstArgument
} from './setup/utils.js';
import { createSetupMeta } from './setup/formattingBase.js';

export class SetupAssistant {
  constructor({ scanner, mediaDownloader, config, configLoader = loadConfig }) {
    this.scanner = scanner;
    this.mediaDownloader = mediaDownloader;
    this.config = config;
    this.configLoader = configLoader;
    this.sessions = new Map();
    this.setupMessages = new Map();
    this.setupSuggestions = new Map();
    this.setupMeta = new Map();
    this.setupLastChange = new Map();
  }

  register(bot) {
    bot.command('setup', (ctx) => this.setupCommand(ctx));
    bot.action(/^setup:(.+)$/, (ctx) => this.setupAction(ctx));
    bot.command('setfilter', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'filters')));
    bot.command('addfilter', (ctx) => this.withSession(ctx, () => this.addRules(ctx, 'filters')));
    bot.command('setauthor', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'author')));
    bot.command('setlikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'likes')));
    bot.command('setdislikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'dislikes')));
    bot.command('setsources', (ctx) => this.withSession(ctx, () => this.setSources(ctx)));
    bot.command('setsource', (ctx) => this.withSession(ctx, () => this.setSource(ctx)));
    bot.command('setpublish', (ctx) => this.withSession(ctx, () => this.setPublish(ctx)));
    bot.command('settemplate', (ctx) => this.withSession(ctx, () => this.setTemplate(ctx)));
    bot.command('test', (ctx) => this.withSession(ctx, () => this.test(ctx)));
    bot.command('raw', (ctx) => this.withSession(ctx, () => this.raw(ctx)));
    bot.command('test_message', (ctx) => this.withSession(ctx, () => this.testMessage(ctx)));
    bot.command('debug', (ctx) => this.withSession(ctx, () => this.debug(ctx)));
    bot.command('preview', (ctx) => this.withSession(ctx, () => this.preview(ctx)));
    bot.command('done', (ctx) => this.withSession(ctx, () => this.done(ctx)));
    bot.command('cancel', (ctx) => this.cancel(ctx));
  }

  async setupCommand(ctx) {
    const action = getArgument(ctx.message.text).toLowerCase();
    if (!action) {
      await this.start(ctx);
      return;
    }

    if (action === 'status') {
      this.ensureSession(ctx);
      await this.status(ctx);
      return;
    }
    if (action === 'doctor') {
      this.ensureSession(ctx);
      await this.doctor(ctx);
      return;
    }
    if (action === 'preview') {
      this.ensureSession(ctx);
      await this.previewDefaults(ctx);
      return;
    }
    if (action === 'parser') {
      this.ensureSession(ctx);
      await this.parserMenu(ctx);
      return;
    }
    if (action === 'parser_config') {
      this.ensureSession(ctx);
      await this.showParserConfig(ctx);
      return;
    }
    if (action === 'suggest' || action === 'suggestions') {
      this.ensureSession(ctx);
      await this.suggestParser(ctx);
      return;
    }
    if (action === 'reset_filters') {
      this.ensureSession(ctx);
      await this.confirmResetFilters(ctx);
      return;
    }
    if (action === 'reset_filters_confirm') {
      this.ensureSession(ctx);
      await this.resetFilters(ctx);
      return;
    }
    if (action === 'publish') {
      this.ensureSession(ctx);
      await this.publishMenu(ctx);
      return;
    }
    if (action === 'publish_presets' || action === 'presets') {
      this.ensureSession(ctx);
      await this.publishPresets(ctx);
      return;
    }
    if (action === 'publish_config') {
      this.ensureSession(ctx);
      await this.showPublishConfig(ctx);
      return;
    }
    if (action === 'advanced') {
      this.ensureSession(ctx);
      await this.advanced(ctx);
      return;
    }
    if (action === 'config') {
      this.ensureSession(ctx);
      await this.showDraftConfig(ctx);
      return;
    }
    if (action === 'save') {
      await this.withSession(ctx, () => this.done(ctx));
      return;
    }
    if (action === 'cancel') {
      await this.cancel(ctx);
      return;
    }

    await this.replyWithKeyboard(
      ctx,
      `Unknown setup action: ${action}\n\nUse /setup or choose a button from the setup menu.`,
      setupMenuKeyboard()
    );
  }

  async setupAction(ctx) {
    const action = ctx.match?.[1] || '';
    await ctx.answerCbQuery().catch(() => {});

    try {
      if (action === 'start' || action === 'restart') {
        await this.start(ctx);
        return;
      }

      if (action === 'cancel') {
        await this.cancel(ctx);
        return;
      }

      this.ensureSession(ctx);

      if (action === 'status') {
        await this.status(ctx);
      } else if (action === 'doctor') {
        await this.doctor(ctx);
      } else if (action === 'preview') {
        await this.previewDefaults(ctx);
      } else if (action === 'test') {
        await this.testDefaults(ctx);
      } else if (action === 'parser') {
        await this.parserMenu(ctx);
      } else if (action === 'parser_config') {
        await this.showParserConfig(ctx);
      } else if (action === 'suggest') {
        await this.suggestParser(ctx);
      } else if (action === 'reset_filters') {
        await this.confirmResetFilters(ctx);
      } else if (action === 'reset_filters_confirm') {
        await this.resetFilters(ctx);
      } else if (action.startsWith('apply:')) {
        await this.applySuggestion(ctx, action.slice('apply:'.length));
      } else if (action.startsWith('noop:')) {
        return;
      } else if (action === 'publish') {
        await this.publishMenu(ctx);
      } else if (action === 'publish_presets') {
        await this.publishPresets(ctx);
      } else if (action === 'publish_config') {
        await this.showPublishConfig(ctx);
      } else if (action.startsWith('preset:')) {
        await this.showPublishPreset(ctx, action.slice('preset:'.length));
      } else if (action.startsWith('apply_preset:')) {
        await this.applyPublishPreset(ctx, action.slice('apply_preset:'.length), { replace: false });
      } else if (action.startsWith('replace_preset:')) {
        await this.confirmReplacePublishPreset(ctx, action.slice('replace_preset:'.length));
      } else if (action.startsWith('replace_preset_confirm:')) {
        await this.applyPublishPreset(ctx, action.slice('replace_preset_confirm:'.length), { replace: true });
      } else if (action === 'last_change') {
        await this.showLastChange(ctx);
      } else if (action === 'advanced') {
        await this.advanced(ctx);
      } else if (action === 'config') {
        await this.showDraftConfig(ctx);
      } else if (action === 'save') {
        await this.done(ctx);
      } else {
        await this.replyWithKeyboard(ctx, `Unknown setup button: ${action}`, setupMenuKeyboard());
      }
    } catch (error) {
      await this.replyWithKeyboard(ctx, `Setup error: ${error.message}`, setupMenuKeyboard());
    }
  }

  async start(ctx) {
    this.reloadConfig();
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
    this.setupMeta.set(ctx.from.id, createSetupMeta());
    this.setupLastChange.delete(ctx.from.id);
    await this.replyWithKeyboard(ctx, formatSetupIntro(this.getDraft(ctx), this.getMeta(ctx)), setupMenuKeyboard());
  }

  async status(ctx) {
    await this.replyWithKeyboard(ctx, formatSetupStatus(this.getDraft(ctx), this.config, this.getMeta(ctx)), setupMenuKeyboard());
  }

  async parserMenu(ctx) {
    await this.replyWithKeyboard(ctx, formatParserMenu(this.getDraft(ctx)), parserMenuKeyboard());
  }

  async publishMenu(ctx) {
    await this.replyWithKeyboard(ctx, formatPublishMenu(this.getDraft(ctx), this.config), publishMenuKeyboard());
  }

  async publishPresets(ctx) {
    await this.replyWithKeyboard(ctx, formatPublishPresetsMenu(this.getDraft(ctx)), publishPresetsKeyboard());
  }

  async showPublishPreset(ctx, presetId) {
    const preset = getPublishPreset(presetId);
    if (!preset) {
      await this.replyWithKeyboard(ctx, 'Unknown publish preset. Choose one from the presets list.', publishPresetsKeyboard());
      return;
    }

    await this.replyWithKeyboard(
      ctx,
      formatPublishPresetDetails(preset, this.getDraft(ctx)),
      publishPresetDetailsKeyboard(preset)
    );
  }

  async applyPublishPreset(ctx, presetId, { replace = false } = {}) {
    const preset = getPublishPreset(presetId);
    if (!preset) {
      await this.replyWithKeyboard(ctx, 'Unknown publish preset. Choose one from the presets list.', publishPresetsKeyboard());
      return;
    }

    const draft = this.getDraft(ctx);
    const beforePublish = structuredClone(draft.publish || {});
    applyPublishPresetToDraft(draft, preset, { replace });
    const afterPublish = structuredClone(draft.publish || {});

    try {
      validateSetupDraft(draft, this.config);
    } catch (error) {
      draft.publish = beforePublish;
      await this.replyWithKeyboard(
        ctx,
        [`Preset was not applied: ${preset.title}`, '', `Validation error: ${error.message}`].join('\n'),
        publishPresetDetailsKeyboard(preset)
      );
      return;
    }

    const detail = formatPublishChanges(beforePublish, afterPublish);
    this.markChanged(ctx, 'publishing', `${replace ? 'Replaced publish templates with preset' : 'Applied publish preset'}: ${preset.title}`, detail);

    await this.replyWithKeyboard(
      ctx,
      formatAppliedPublishPreset({ preset, beforePublish, afterPublish, replace }),
      publishAfterPresetKeyboard()
    );
  }

  async confirmReplacePublishPreset(ctx, presetId) {
    const preset = getPublishPreset(presetId);
    if (!preset) {
      await this.replyWithKeyboard(ctx, 'Unknown publish preset. Choose one from the presets list.', publishPresetsKeyboard());
      return;
    }

    const currentCount = Array.isArray(this.getDraft(ctx).publish?.template) ? this.getDraft(ctx).publish.template.length : 0;
    await this.replyWithKeyboard(
      ctx,
      formatConfirmReplacePublishPreset(preset, currentCount),
      confirmReplacePublishPresetKeyboard(preset)
    );
  }

  async showPublishConfig(ctx) {
    await ctx.reply('Current publishing config:');
    await replyJsonCode(ctx, this.getDraft(ctx).publish || {});
    await this.replyWithKeyboard(ctx, 'Use presets for common schedules, or Advanced JSON for exact tuning.', publishMenuKeyboard());
  }

  async advanced(ctx) {
    await this.replyWithKeyboard(ctx, ADVANCED_HELP, advancedMenuKeyboard());
  }

  async showDraftConfig(ctx) {
    await ctx.reply('Current setup draft:');
    await replyJsonCode(ctx, JSON.parse(formatDraftConfig(this.getDraft(ctx))));
    await this.replyWithKeyboard(ctx, 'Use the buttons to continue setup.', setupMenuKeyboard());
  }

  async showParserConfig(ctx) {
    await ctx.reply('Current parser rules:');
    await replyJsonCode(ctx, this.getDraft(ctx).parsing || {});
    await this.replyWithKeyboard(ctx, 'Use Test parser or Preview to check these rules against real source posts.', parserMenuKeyboard());
  }

  async doctor(ctx) {
    const draft = this.getDraft(ctx);
    await ctx.reply(`Running setup doctor on the latest ${DEFAULT_TEST_MESSAGES} source messages...`);
    const result = await this.scanner.previewRecent(DEFAULT_TEST_MESSAGES, draft);
    await this.replyWithKeyboard(ctx, formatSetupDoctor({ draft, baseConfig: this.config, preview: result }), setupMenuKeyboard());
  }

  async testDefaults(ctx) {
    const result = await this.scanner.previewRecent(DEFAULT_TEST_MESSAGES, this.getDraft(ctx));
    await replyCode(ctx, summarizeParsedPosts(result, { maxRows: 12 }));
    this.markTested(ctx);
    await this.replyWithKeyboard(ctx, 'Parser test finished.', parserMenuKeyboard());
  }

  async previewDefaults(ctx) {
    await this.sendPreview(ctx, {
      postCount: DEFAULT_PREVIEW_POSTS,
      messageCount: DEFAULT_PREVIEW_MESSAGES
    });
  }


  async suggestParser(ctx) {
    const draft = this.getDraft(ctx);
    await ctx.reply(`Scanning the latest ${DEFAULT_TEST_MESSAGES} source messages for parser suggestions...`);
    const result = await this.scanner.previewRecent(DEFAULT_TEST_MESSAGES, draft, { includeMessages: true });
    const suggestions = buildParserSuggestions(result.messages || [], draft);
    this.setupSuggestions.set(ctx.from.id, suggestions);
    await this.replyWithKeyboard(
      ctx,
      formatParserSuggestions({
        suggestions: markSuggestionStates(suggestions, draft),
        scanned: result.scanned,
        matched: result.posts.length
      }),
      parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
    );
  }

  async applySuggestion(ctx, suggestionId) {
    const suggestions = this.setupSuggestions.get(ctx.from.id) || [];
    const suggestion = suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) {
      await this.replyWithKeyboard(
        ctx,
        'This suggestion is no longer available. Run Auto suggestions again.',
        parserMenuKeyboard()
      );
      return;
    }

    const draft = this.getDraft(ctx);
    if (!isSuggestionUseful(suggestion, draft)) {
      await this.replyWithKeyboard(
        ctx,
        formatNoopSuggestion(suggestion),
        parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
      );
      return;
    }

    const beforeParsing = structuredClone(draft.parsing || {});
    suggestion.apply(draft);
    const afterParsing = structuredClone(draft.parsing || {});
    const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
    this.markChanged(ctx, 'parser', `Applied parser suggestion: ${suggestion.title}`, detail);
    await this.replyWithKeyboard(
      ctx,
      [
        formatAppliedSuggestion({ suggestion, beforeParsing, afterParsing }),
        '',
        'You can apply another suggestion from the same list, or run Test parser / Preview.'
      ].join('\n'),
      parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
    );
  }

  async confirmResetFilters(ctx) {
    const filters = this.getDraft(ctx).parsing?.filters || [];
    await this.replyWithKeyboard(ctx, formatConfirmResetFilters(filters), confirmResetFiltersKeyboard());
  }

  async resetFilters(ctx) {
    const draft = this.getDraft(ctx);
    const beforeParsing = structuredClone(draft.parsing || {});
    draft.parsing.filters = [];
    const afterParsing = structuredClone(draft.parsing || {});
    const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
    this.markChanged(ctx, 'parser', 'Reset parser filters', detail);
    const suggestions = this.setupSuggestions.get(ctx.from.id) || [];
    const keyboard = suggestions.length
      ? parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
      : parserMenuKeyboard();
    await this.replyWithKeyboard(
      ctx,
      formatFiltersReset({ beforeParsing, afterParsing, hasSuggestions: suggestions.length > 0 }),
      keyboard
    );
  }

  async setRules(ctx, key) {
    const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
    const rules = parseJsonArgument(ctx.message.text);
    setParsingRules(this.getDraft(ctx), key, rules);
    this.markChanged(ctx, 'parser', `${key} replaced`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
    await this.replyWithKeyboard(ctx, `${key} replaced. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async addRules(ctx, key) {
    const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
    const rules = parseJsonArgument(ctx.message.text);
    addParsingRule(this.getDraft(ctx), key, rules);
    this.markChanged(ctx, 'parser', `${key} appended`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
    await this.replyWithKeyboard(ctx, `${key} appended. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async setTemplate(ctx) {
    const [key, value] = splitFirstArgument(ctx.message.text);
    if (!key || !value) throw new Error('Usage: /settemplate <key> <value>');
    setTemplateValue(this.getDraft(ctx), key, value);
    this.markChanged(ctx, 'templates', `${key} template updated`, [`- ${key}`]);
    await this.replyWithKeyboard(ctx, `${key} template updated. Use Preview to check the result.`, setupMenuKeyboard());
  }

  async setSources(ctx) {
    const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
    const sources = parseJsonArgument(ctx.message.text);
    setPublishSources(this.getDraft(ctx), sources);
    this.markChanged(ctx, 'publishing', 'publish.sources replaced', formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
    await this.replyWithKeyboard(ctx, 'publish.sources replaced. Run Doctor or Save when ready.', publishMenuKeyboard());
  }

  async setSource(ctx) {
    const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
    const source = parseJsonArgument(ctx.message.text);
    upsertPublishSource(this.getDraft(ctx), source);
    this.markChanged(ctx, 'publishing', `publish.sources.${source.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
    await this.replyWithKeyboard(ctx, `publish.sources.${source.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async setPublish(ctx) {
    const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
    const template = parseJsonArgument(ctx.message.text);
    setPublishTemplate(this.getDraft(ctx), template);
    this.markChanged(ctx, 'publishing', `publish.template.${template.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
    await this.replyWithKeyboard(ctx, `publish.template.${template.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async test(ctx) {
    const limit = parseLimit(ctx.message.text, DEFAULT_TEST_MESSAGES);
    const result = await this.scanner.previewRecent(limit, this.getDraft(ctx));
    await replyCode(ctx, summarizeParsedPosts(result));
    this.markTested(ctx);
  }

  async raw(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const message = await this.scanner.getMessageById(messageId);
    if (!message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyJsonFile(ctx, message, `telegram-message-${messageId}.json`);
  }

  async testMessage(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const result = await this.scanner.previewMessage(messageId, this.getDraft(ctx));
    if (!result.message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyCode(ctx, summarizeParsedPosts({ scanned: 1, posts: result.posts }));
    if (!result.posts.length) {
      await this.replyWithKeyboard(ctx, 'Message did not match the current parser rules.', parserMenuKeyboard());
      return;
    }
    await replyJsonCode(ctx, result.posts.length === 1 ? result.posts[0] : result.posts);
  }

  async debug(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const result = await this.scanner.debugMessage(messageId, this.getDraft(ctx));
    if (!result.message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyJsonFile(ctx, result.debug, `telegram-message-${messageId}-debug.json`);
  }

  async preview(ctx) {
    const args = parsePreviewArgs(ctx.message.text);
    await this.sendPreview(ctx, args);
  }

  async sendPreview(ctx, { postCount, messageCount }) {
    const result = await this.scanner.previewRecent(messageCount, this.getDraft(ctx));
    const posts = selectWeekPreviewPosts(result.posts, postCount);
    const draft = this.getDraft(ctx);
    this.markPreviewed(ctx);
    await this.replyWithKeyboard(ctx, [
      `Preview source: ${result.posts.length} matched posts from ${result.scanned} scanned messages.`,
      `Showing ${posts.length} selected post(s).`,
      '',
      'If the match set is wrong, use Parser → Auto suggestions or Advanced JSON.'
    ].join('\n'), previewMenuKeyboard());

    if (!posts.length) {
      await this.replyWithKeyboard(ctx, formatPreviewPost(null, draft.templates), previewMenuKeyboard());
      return;
    }

    for (let index = 0; index < posts.length; index += 1) {
      await sendRichPost({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        mediaDownloader: this.mediaDownloader,
        post: posts[index],
        index,
        templates: draft.templates
      });
    }
  }

  async done(ctx) {
    const draft = this.getDraft(ctx);
    validateSetupDraft(draft, this.config);
    const result = await saveDraftConfig(draft);
    this.reloadConfig();
    await this.clearLastSetupKeyboard(ctx);
    await ctx.reply([
      `Config saved: ${result.configPath}`,
      `Backup: ${result.backupPath}`,
      '',
      'Final config snippet:'
    ].join('\n'));
    await replyJsonCode(ctx, JSON.parse(formatDraftConfig(draft)));
    this.sessions.delete(ctx.from.id);
    this.setupSuggestions.delete(ctx.from.id);
    this.setupMeta.delete(ctx.from.id);
    this.setupLastChange.delete(ctx.from.id);
  }

  async cancel(ctx) {
    this.sessions.delete(ctx.from.id);
    this.setupSuggestions.delete(ctx.from.id);
    this.setupMeta.delete(ctx.from.id);
    this.setupLastChange.delete(ctx.from.id);
    await this.clearLastSetupKeyboard(ctx);
    await ctx.reply('Setup mode cancelled.');
  }

  async withSession(ctx, handler) {
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


  async replyWithKeyboard(ctx, text, keyboard, extra = {}) {
    await this.clearLastSetupKeyboard(ctx);
    const message = await ctx.reply(text, mergeReplyOptions(extra, keyboard));
    this.rememberSetupKeyboard(ctx, message);
    return message;
  }

  async clearLastSetupKeyboard(ctx) {
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

  rememberSetupKeyboard(ctx, message) {
    if (!message?.message_id || !message?.chat?.id) return;
    this.setupMessages.set(ctx.from.id, {
      chatId: message.chat.id,
      messageId: message.message_id
    });
  }

  ensureSession(ctx) {
    if (this.sessions.has(ctx.from.id)) return;
    this.reloadConfig();
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
  }

  getDraft(ctx) {
    return this.sessions.get(ctx.from.id);
  }

  getMeta(ctx) {
    if (!this.setupMeta.has(ctx.from.id)) this.setupMeta.set(ctx.from.id, createSetupMeta());
    return this.setupMeta.get(ctx.from.id);
  }

  markChanged(ctx, area, title, detailLines = []) {
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

  markPreviewed(ctx) {
    this.getMeta(ctx).previewedAt = Date.now();
  }

  markTested(ctx) {
    this.getMeta(ctx).testedAt = Date.now();
  }

  async showLastChange(ctx) {
    const change = this.setupLastChange.get(ctx.from.id);
    if (!change) {
      await this.replyWithKeyboard(ctx, formatNoLastChange(), setupMenuKeyboard());
      return;
    }
    await this.replyWithKeyboard(ctx, formatLastChange(change), lastChangeKeyboard(change.area));
  }

  reloadConfig() {
    replaceObjectContents(this.config, this.configLoader());
  }
}

export { stringifyForSetup } from './setup/utils.js';
