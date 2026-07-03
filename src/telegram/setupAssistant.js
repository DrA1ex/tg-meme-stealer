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

const DEFAULT_TEST_MESSAGES = 30;
const DEFAULT_PREVIEW_MESSAGES = 100;
const DEFAULT_PREVIEW_POSTS = 5;

const ADVANCED_HELP = [
  'Advanced setup commands:',
  '',
  'Parser JSON:',
  '/setfilter <json rule or array>',
  '/addfilter <json rule or array>',
  '/setauthor <json rule or array>',
  '/setlikes <json rule or array>',
  '/setdislikes <json rule or array>',
  '',
  'Publishing JSON:',
  '/setsources <json array>',
  '/setsource <json object>',
  '/setpublish <json object>',
  '/settemplate <key> <value>',
  '',
  'Inspection:',
  '/test [message_count]',
  '/preview [post_count] [message_count]',
  '/raw <message_id>',
  '/test_message <message_id>',
  '/debug <message_id>',
  '',
  'Finish:',
  '/done',
  '/cancel',
  '',
  'These commands are kept for precise manual tuning. The main /setup flow now uses buttons first.'
].join('\n');

export class SetupAssistant {
  constructor({ scanner, mediaDownloader, config, configLoader = loadConfig }) {
    this.scanner = scanner;
    this.mediaDownloader = mediaDownloader;
    this.config = config;
    this.configLoader = configLoader;
    this.sessions = new Map();
    this.setupMessages = new Map();
    this.setupSuggestions = new Map();
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
    if (action === 'publish') {
      this.ensureSession(ctx);
      await this.publishMenu(ctx);
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
      } else if (action.startsWith('apply:')) {
        await this.applySuggestion(ctx, action.slice('apply:'.length));
      } else if (action === 'publish') {
        await this.publishMenu(ctx);
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
    await this.replyWithKeyboard(ctx, formatSetupIntro(this.getDraft(ctx)), setupMenuKeyboard());
  }

  async status(ctx) {
    await this.replyWithKeyboard(ctx, formatSetupStatus(this.getDraft(ctx), this.config), setupMenuKeyboard());
  }

  async parserMenu(ctx) {
    await this.replyWithKeyboard(ctx, formatParserMenu(this.getDraft(ctx)), parserMenuKeyboard());
  }

  async publishMenu(ctx) {
    await this.replyWithKeyboard(ctx, formatPublishMenu(this.getDraft(ctx), this.config), publishMenuKeyboard());
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
      formatParserSuggestions({ suggestions, scanned: result.scanned, matched: result.posts.length }),
      parserSuggestionsKeyboard(suggestions)
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

    suggestion.apply(this.getDraft(ctx));
    await this.replyWithKeyboard(
      ctx,
      [`Applied: ${suggestion.title}`, '', suggestion.afterApply || 'Run Test parser or Preview to check the result.'].join('\n'),
      parserMenuKeyboard()
    );
  }

  async setRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    setParsingRules(this.getDraft(ctx), key, rules);
    await this.replyWithKeyboard(ctx, `${key} replaced. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async addRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    addParsingRule(this.getDraft(ctx), key, rules);
    await this.replyWithKeyboard(ctx, `${key} appended. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async setTemplate(ctx) {
    const [key, value] = splitFirstArgument(ctx.message.text);
    if (!key || !value) throw new Error('Usage: /settemplate <key> <value>');
    setTemplateValue(this.getDraft(ctx), key, value);
    await this.replyWithKeyboard(ctx, `${key} template updated. Use Preview to check the result.`, setupMenuKeyboard());
  }

  async setSources(ctx) {
    const sources = parseJsonArgument(ctx.message.text);
    setPublishSources(this.getDraft(ctx), sources);
    await this.replyWithKeyboard(ctx, 'publish.sources replaced. Run Doctor or Save when ready.', publishMenuKeyboard());
  }

  async setSource(ctx) {
    const source = parseJsonArgument(ctx.message.text);
    upsertPublishSource(this.getDraft(ctx), source);
    await this.replyWithKeyboard(ctx, `publish.sources.${source.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async setPublish(ctx) {
    const template = parseJsonArgument(ctx.message.text);
    setPublishTemplate(this.getDraft(ctx), template);
    await this.replyWithKeyboard(ctx, `publish.template.${template.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async test(ctx) {
    const limit = parseLimit(ctx.message.text, DEFAULT_TEST_MESSAGES);
    const result = await this.scanner.previewRecent(limit, this.getDraft(ctx));
    await replyCode(ctx, summarizeParsedPosts(result));
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
  }

  async cancel(ctx) {
    this.sessions.delete(ctx.from.id);
    this.setupSuggestions.delete(ctx.from.id);
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

  reloadConfig() {
    replaceObjectContents(this.config, this.configLoader());
  }
}

function formatSetupIntro(draft) {
  return [
    'Setup mode started.',
    '',
    'Use buttons for the common flow: check status, run doctor, preview selected posts, then save.',
    'Advanced JSON commands are still available, but they are no longer the main path.',
    '',
    formatSetupStatus(draft)
  ].join('\n');
}

function formatSetupStatus(draft, baseConfig = {}) {
  const parsing = draft.parsing || {};
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const enabledTemplates = templates.filter((template) => template.enabled !== false);
  const disabledTemplates = templates.length - enabledTemplates.length;
  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);

  return [
    'Setup status',
    '',
    `Parser: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author rule(s), ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`,
    `Publishing: ${templates.length} template(s), ${enabledTemplates.length} enabled, ${disabledTemplates} disabled, ${sources.length} source(s).`,
    `Runtime: dryRun=${Boolean(publish.dryRun)}, timezone=${baseConfig.schedule?.timezone || 'default'}.`,
    firstSendAt ? `First send gate: ${firstSendAt}` : 'First send gate: not set.',
    '',
    'Enabled templates:',
    ...formatTemplateLines(enabledTemplates),
    '',
    'Next steps:',
    '- Doctor checks obvious config and parser issues.',
    '- Preview sends real candidate posts to this chat.',
    '- Parser → Auto suggestions can now detect common filters, author rules, and reaction buttons.',
    '- Phase 3 will add publish presets such as daily top, morning/night, weekly and controversial.'
  ].join('\n');
}

function formatParserMenu(draft) {
  const parsing = draft.parsing || {};
  return [
    'Parser setup',
    '',
    `Current rules: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author, ${countRules(parsing.likes)} likes, ${countRules(parsing.dislikes)} dislikes.`,
    '',
    'Available now:',
    '- Auto suggestions scans recent source messages and offers buttons for common filters, author extraction, and reaction buttons.',
    '- Test parser scans recent messages and shows matched rows.',
    '- Preview sends selected rich posts.',
    '- Advanced JSON lets you edit exact rules.',
    '',
    'Phase 3 target: button presets for publish templates. Advanced JSON remains available for exact tuning.'
  ].join('\n');
}

function formatPublishMenu(draft, baseConfig = {}) {
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  return [
    'Publishing setup',
    '',
    `Sources: ${sources.length}`,
    `Templates: ${templates.length}`,
    `Timezone: ${baseConfig.schedule?.timezone || 'default'}`,
    '',
    ...formatTemplateLines(templates, { includeDisabled: true }),
    '',
    'Available now:',
    '- Status and Doctor explain the current config.',
    '- Advanced JSON edits exact sources/templates.',
    '',
    'Phase 3 target: button presets for Daily top, Morning + night top, Weekly top, Monthly top, and Controversial.'
  ].join('\n');
}

function formatSetupDoctor({ draft, baseConfig, preview }) {
  const warnings = [];
  const notes = [];
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const sourceKeys = new Set(sources.map((source) => source.key));

  try {
    validateSetupDraft(draft, baseConfig);
    notes.push('Config validation: ok.');
  } catch (error) {
    warnings.push(`Config validation failed: ${error.message}`);
  }

  const matchRatio = preview.scanned > 0 ? preview.posts.length / preview.scanned : 0;
  notes.push(`Parser preview: ${preview.posts.length} matched post(s) from ${preview.scanned} scanned message(s).`);
  if (preview.scanned > 0 && preview.posts.length === 0) {
    warnings.push('Parser matched nothing in recent messages. Filters may be too strict or paths may be wrong.');
  } else if (preview.scanned >= 10 && matchRatio < 0.1) {
    warnings.push('Parser matched less than 10% of recent messages. This can be fine for strict channels, but check rejected messages if selection looks empty.');
  } else if (preview.scanned >= 10 && matchRatio > 0.9) {
    warnings.push('Parser matched more than 90% of recent messages. This can be too broad if the source chat contains non-post messages.');
  }

  for (const template of templates) {
    if (template.source && !sourceKeys.has(template.source)) {
      warnings.push(`Template ${template.key || '<missing key>'} uses unknown source ${template.source}.`);
    }
  }

  for (const duplicate of findDuplicates(templates.map((template) => template.key).filter(Boolean))) {
    warnings.push(`Duplicate publish template key: ${duplicate}.`);
  }

  for (const conflict of findScheduleConflicts(templates)) {
    warnings.push(`Schedule conflict: ${conflict}.`);
  }

  const disabled = templates.filter((template) => template.enabled === false);
  if (disabled.length) {
    notes.push(`Disabled templates: ${disabled.map((template) => template.key).join(', ')}.`);
  }

  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);
  if (firstSendAt) {
    notes.push(`First send gate is set to ${firstSendAt}. Runs before this timestamp are skipped unless forced.`);
  }

  if (!templates.length) warnings.push('No publish templates configured.');
  if (!sources.length) warnings.push('No publish sources configured.');

  return [
    'Setup doctor',
    '',
    warnings.length ? 'Warnings:' : 'Warnings: none.',
    ...warnings.map((warning) => `- ${warning}`),
    '',
    'Notes:',
    ...notes.map((note) => `- ${note}`),
    '',
    'Use Preview to inspect real output before saving.'
  ].join('\n');
}


function buildParserSuggestions(messages, draft = {}) {
  const stats = analyzeMessagesForParser(messages);
  const suggestions = [];

  const recommendedFilters = [{ source: 'message', transform: 'hasContent' }];
  if (stats.mediaCount > 0 && stats.mediaCount / Math.max(1, stats.scanned) >= 0.4) {
    recommendedFilters.push({ source: 'message', transform: 'hasMedia' });
  }
  if (stats.topSender && stats.topSender.count / Math.max(1, stats.scanned) >= 0.5) {
    recommendedFilters.push({ source: 'sender', path: 'id', transform: 'equals', value: stats.topSender.id });
  }

  const authorSuggestion = buildAuthorSuggestion(stats);
  const reactionSuggestion = buildReactionSuggestion(stats);

  suggestions.push({
    id: 'rec',
    title: 'Apply suggested parser',
    description: [
      `Set ${recommendedFilters.length} filter rule(s)`,
      authorSuggestion ? 'set author detection' : 'keep current author rules',
      reactionSuggestion ? 'set reaction button parsing' : 'keep current reaction rules'
    ].join(', '),
    recommended: true,
    apply: (draftConfig) => {
      draftConfig.parsing.filters = structuredClone(recommendedFilters);
      if (authorSuggestion) draftConfig.parsing.author = structuredClone(authorSuggestion.rules);
      if (reactionSuggestion) {
        draftConfig.parsing.likes = structuredClone(reactionSuggestion.likesRules);
        draftConfig.parsing.dislikes = structuredClone(reactionSuggestion.dislikesRules);
      }
    },
    afterApply: 'Suggested filters/extractors were applied. Run Test parser, then Preview.'
  });

  suggestions.push({
    id: 'f_content',
    title: 'Add hasContent filter',
    description: `${stats.contentCount}/${stats.scanned} recent messages have text or supported media`,
    apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', { source: 'message', transform: 'hasContent' })
  });

  if (stats.mediaCount > 0) {
    suggestions.push({
      id: 'f_media',
      title: 'Add hasMedia filter',
      description: `${stats.mediaCount}/${stats.scanned} recent messages have photo/video media`,
      apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', { source: 'message', transform: 'hasMedia' })
    });
  }

  if (stats.topSender) {
    suggestions.push({
      id: 'f_sender',
      title: `Add top sender filter`,
      description: `sender ${stats.topSender.id} appears in ${stats.topSender.count}/${stats.scanned} recent messages${stats.topSender.label ? ` (${stats.topSender.label})` : ''}`,
      apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', {
        source: 'sender',
        path: 'id',
        transform: 'equals',
        value: stats.topSender.id
      })
    });
  }

  if (authorSuggestion) {
    suggestions.push({
      id: 'a_line',
      title: authorSuggestion.title,
      description: authorSuggestion.description,
      apply: (draftConfig) => {
        draftConfig.parsing.author = structuredClone(authorSuggestion.rules);
      }
    });
  }

  if (stats.senderNameCount > 0) {
    suggestions.push({
      id: 'a_name',
      title: 'Use sender first name as author',
      description: `${stats.senderNameCount}/${stats.scanned} recent messages have sender.firstName`,
      apply: (draftConfig) => {
        draftConfig.parsing.author = [{ source: 'sender', path: 'firstName', transform: 'trim' }];
      }
    });
  }

  if (stats.senderUsernameCount > 0) {
    suggestions.push({
      id: 'a_user',
      title: 'Use sender username as author',
      description: `${stats.senderUsernameCount}/${stats.scanned} recent messages have sender.username`,
      apply: (draftConfig) => {
        draftConfig.parsing.author = [{ source: 'sender', path: 'username', regex: '(.+)', group: 1, transform: 'telegramUsername' }];
      }
    });
  }

  if (reactionSuggestion) {
    suggestions.push({
      id: 'r_buttons',
      title: reactionSuggestion.title,
      description: reactionSuggestion.description,
      apply: (draftConfig) => {
        draftConfig.parsing.likes = structuredClone(reactionSuggestion.likesRules);
        draftConfig.parsing.dislikes = structuredClone(reactionSuggestion.dislikesRules);
      }
    });
  }

  return suggestions.filter((suggestion) => isSuggestionUseful(suggestion, draft));
}

function analyzeMessagesForParser(messages) {
  const stats = {
    scanned: messages.length,
    contentCount: 0,
    mediaCount: 0,
    senderNameCount: 0,
    senderUsernameCount: 0,
    senderCounts: new Map(),
    senderLabels: new Map(),
    authorLines: [],
    buttonPaths: new Map()
  };

  for (const message of messages) {
    if (hasSetupContent(message)) stats.contentCount += 1;
    if (hasSetupMedia(message)) stats.mediaCount += 1;

    const sender = message?.sender || null;
    const senderId = getSetupSenderId(message);
    if (senderId) {
      stats.senderCounts.set(senderId, (stats.senderCounts.get(senderId) || 0) + 1);
      const label = formatSetupSenderLabel(sender);
      if (label) stats.senderLabels.set(senderId, label);
    }
    if (sender?.firstName) stats.senderNameCount += 1;
    if (sender?.username) stats.senderUsernameCount += 1;

    const textValues = [
      { path: 'text', value: message?.text || '' },
      { path: 'message', value: message?.message || '' }
    ];
    for (const item of textValues) {
      for (const pattern of getAuthorLinePatterns()) {
        if (pattern.regex.test(item.value)) {
          stats.authorLines.push({ path: item.path, label: pattern.label, regex: pattern.ruleRegex });
        }
      }
    }

    for (const path of ['markup.buttons[].text', 'replyMarkup.rows[].buttons[].text']) {
      const values = getSetupValuesByPath(message, path).filter((value) => String(value || '').trim());
      if (!values.length) continue;
      const current = stats.buttonPaths.get(path) || [];
      current.push(...values.map(String));
      stats.buttonPaths.set(path, current);
    }
  }

  stats.topSender = getTopSender(stats.senderCounts, stats.senderLabels);
  return stats;
}

function buildAuthorSuggestion(stats) {
  const counts = new Map();
  for (const item of stats.authorLines) {
    const key = `${item.path}\t${item.label}\t${item.regex}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;

  const [path, label, regex] = best[0].split('\t');
  const count = best[1];
  return {
    title: `Use "${label}" line as author`,
    description: `${count}/${stats.scanned} recent messages contain this author line on message.${path}`,
    rules: [{ source: 'message', path, regex, group: 1, transform: 'trim' }]
  };
}

function buildReactionSuggestion(stats) {
  const bestPath = [...stats.buttonPaths.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!bestPath) return null;

  const [path, texts] = bestPath;
  const likeMarkers = getDetectedMarkers(texts, ['👍', '❤', '❤️', '🔥', '+']);
  const dislikeMarkers = getDetectedMarkers(texts, ['👎', '-']);
  if (!likeMarkers.length && !dislikeMarkers.length) return null;

  const likesRules = likeMarkers.length ? buildReactionRules(path, likeMarkers) : [];
  const dislikesRules = dislikeMarkers.length ? buildReactionRules(path, dislikeMarkers) : [];
  return {
    title: 'Use detected reaction buttons',
    description: `path=${path}, likes=${likeMarkers.join(' ') || 'none'}, dislikes=${dislikeMarkers.join(' ') || 'none'}, button texts=${texts.length}`,
    likesRules,
    dislikesRules
  };
}

function buildReactionRules(path, markers) {
  const markerRegex = markers.map(escapeRegex).join('|');
  return [
    {
      source: 'message',
      path,
      regex: `(?:${markerRegex})\\s*([\\d\\s,.]+[km]?)`,
      group: 1,
      transform: 'count',
      aggregate: 'sum'
    },
    {
      source: 'message',
      path,
      regex: `\\s*([\\d\\s,.]+[km]?)\\s*(?:${markerRegex})`,
      group: 1,
      transform: 'count',
      aggregate: 'sum'
    }
  ];
}

function formatAppliedSuggestion({ suggestion, beforeParsing, afterParsing }) {
  const changes = formatParserChanges(beforeParsing, afterParsing);
  const lines = [
    `Applied: ${suggestion.title}`,
    '',
    'Changed parser rules:',
    ...changes,
    '',
    suggestion.afterApply || 'Run Test parser or Preview to check the result.'
  ];
  return lines.join('\n');
}

function formatParserChanges(beforeParsing, afterParsing) {
  const sections = ['filters', 'author', 'likes', 'dislikes'];
  const lines = [];
  for (const section of sections) {
    const before = Array.isArray(beforeParsing?.[section]) ? beforeParsing[section] : [];
    const after = Array.isArray(afterParsing?.[section]) ? afterParsing[section] : [];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const action = before.length && after.length ? 'updated' : before.length ? 'cleared' : 'added';
    lines.push(`- ${section}: ${before.length} → ${after.length} rule(s), ${action}.`);
    for (const rule of after.slice(0, 4)) {
      lines.push(`  ${compactRule(rule)}`);
    }
    if (after.length > 4) lines.push(`  ...and ${after.length - 4} more rule(s)`);
  }
  return lines.length ? lines : ['- No parser changes.'];
}

function compactRule(rule) {
  const parts = [];
  if (rule.source) parts.push(String(rule.source));
  if (rule.path) parts.push(String(rule.path));
  if (rule.transform) parts.push(`transform=${rule.transform}`);
  if (rule.value !== undefined) parts.push(`value=${JSON.stringify(rule.value)}`);
  if (Array.isArray(rule.values)) parts.push(`values=${JSON.stringify(rule.values)}`);
  if (rule.regex) parts.push(`regex=${JSON.stringify(rule.regex)}`);
  return parts.join(' · ') || JSON.stringify(rule);
}

function formatParserSuggestions({ suggestions, scanned, matched }) {
  const lines = [
    'Parser auto-suggestions',
    '',
    `Scanned ${scanned} recent source message(s). Current parser matched ${matched}.`,
    '',
    'Suggestions:'
  ];

  if (!suggestions.length) {
    lines.push('- No useful suggestions found. Use Advanced JSON with /raw or /debug for this source shape.');
  } else {
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion.title}: ${suggestion.description}`);
    }
  }

  lines.push('', 'Choose a button, then run Test parser and Preview before saving.');
  return lines.join('\n');
}

function parserSuggestionsKeyboard(suggestions) {
  if (!suggestions.length) {
    return inlineKeyboard([
      [button('Advanced JSON', 'setup:advanced'), button('Back', 'setup:parser')]
    ]);
  }

  const rows = [];
  const recommended = suggestions.find((suggestion) => suggestion.recommended);
  if (recommended) rows.push([button(recommended.title, `setup:apply:${recommended.id}`)]);

  const regular = suggestions.filter((suggestion) => !suggestion.recommended);
  for (let index = 0; index < regular.length; index += 2) {
    rows.push(regular.slice(index, index + 2).map((suggestion) => button(shortSuggestionTitle(suggestion.title), `setup:apply:${suggestion.id}`)));
  }
  rows.push([button('Test parser', 'setup:test'), button('Preview', 'setup:preview')]);
  rows.push([button('Show parser config', 'setup:parser_config')]);
  rows.push([button('Advanced JSON', 'setup:advanced'), button('Back', 'setup:parser')]);
  return inlineKeyboard(rows);
}

function shortSuggestionTitle(title) {
  return String(title)
    .replace('Add ', '+ ')
    .replace('Use ', 'Use ')
    .replace(' as author', '')
    .replace('detected ', '')
    .slice(0, 32);
}

function isSuggestionUseful(suggestion, draft) {
  const clone = structuredClone(draft || {});
  const before = JSON.stringify(clone.parsing || {});
  suggestion.apply(clone);
  const after = JSON.stringify(clone.parsing || {});
  return before !== after;
}

function addUniqueParsingRule(draft, key, rule) {
  draft.parsing[key] = Array.isArray(draft.parsing[key]) ? draft.parsing[key] : [];
  const normalized = JSON.stringify(rule);
  if (!draft.parsing[key].some((item) => JSON.stringify(item) === normalized)) {
    draft.parsing[key].push(structuredClone(rule));
  }
}

function getAuthorLinePatterns() {
  return [
    { label: 'От ...', regex: /(?:^|\n)\s*От\s+(.+?)(?:\n|$)/i, ruleRegex: '(?:^|\\n)\\s*От\\s+(.+?)(?:\\n|$)' },
    { label: 'By ...', regex: /(?:^|\n)\s*By\s+(.+?)(?:\n|$)/i, ruleRegex: '(?:^|\\n)\\s*By\\s+(.+?)(?:\\n|$)' }
  ];
}

function hasSetupContent(message) {
  return hasSetupMedia(message) || String(message?.text || message?.message || '').trim().length > 0;
}

function hasSetupMedia(message) {
  return getSetupMediaKind(message) !== 'text';
}

function getSetupMediaKind(message) {
  if (message?.media?.type === 'photo' || message?.photo || message?.media?.photo || message?.media?.className === 'MessageMediaPhoto') return 'photo';
  const document = message?.document || message?.media?.document || message?.media;
  const mimeType = document?.mimeType || '';
  if (message?.media?.type === 'video' || message?.video || message?.media?.video || message?.media?.className === 'MessageMediaDocument' && mimeType.startsWith('video/')) return 'video';
  return 'text';
}

function getSetupSenderId(message) {
  const raw = message?.sender?.id?.value ?? message?.sender?.id ?? message?.senderId?.value ?? message?.senderId ?? message?.fromId?.userId?.value ?? message?.fromId?.userId;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatSetupSenderLabel(sender) {
  if (!sender) return '';
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim();
  if (name && sender.username) return `${name} / @${sender.username}`;
  if (name) return name;
  if (sender.username) return `@${sender.username}`;
  return '';
}

function getTopSender(senderCounts, senderLabels) {
  const best = [...senderCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  return { id: best[0], count: best[1], label: senderLabels.get(best[0]) || '' };
}

function getSetupValuesByPath(root, path) {
  if (!path) return [root];
  let values = [root];
  for (const part of path.split('.')) {
    values = resolveSetupPathPart(values, part);
  }
  return values.filter((value) => value !== undefined && value !== null);
}

function resolveSetupPathPart(values, part) {
  const match = String(part).match(/^([^\[]*)((?:\[\])*)$/);
  const key = match?.[1] || '';
  const arrayDepth = (match?.[2]?.match(/\[\]/g) || []).length;
  let next = values.flatMap((value) => {
    if (!key) return [value];
    if (Array.isArray(value)) return value.flatMap((item) => item?.[key]);
    return [value?.[key]];
  });
  for (let index = 0; index < arrayDepth; index += 1) {
    next = next.flatMap((value) => Array.isArray(value) ? value : []);
  }
  return next;
}

function getDetectedMarkers(texts, markers) {
  return markers.filter((marker) => texts.some((text) => String(text).includes(marker)));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setupMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Doctor', 'setup:doctor')],
    [button('Preview', 'setup:preview'), button('Test parser', 'setup:test')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Advanced JSON', 'setup:advanced'), button('Show config', 'setup:config')],
    [button('Save', 'setup:save'), button('Cancel', 'setup:cancel')]
  ]);
}

function parserMenuKeyboard() {
  return inlineKeyboard([
    [button('Auto suggestions', 'setup:suggest')],
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Show parser config', 'setup:parser_config')],
    [button('Advanced JSON', 'setup:advanced'), button('Status', 'setup:status')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function parserAfterApplyKeyboard() {
  return inlineKeyboard([
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Show parser config', 'setup:parser_config')],
    [button('More suggestions', 'setup:suggest'), button('Back', 'setup:parser')]
  ]);
}

function publishMenuKeyboard() {
  return inlineKeyboard([
    [button('Doctor', 'setup:doctor'), button('Preview', 'setup:preview')],
    [button('Advanced JSON', 'setup:advanced'), button('Show config', 'setup:config')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function previewMenuKeyboard() {
  return inlineKeyboard([
    [button('Looks good / Save', 'setup:save'), button('Run doctor', 'setup:doctor')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function advancedMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Show config', 'setup:config')],
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function mergeReplyOptions(extra, keyboard) {
  return {
    ...(extra || {}),
    ...(keyboard || {}),
    reply_markup: {
      ...(extra?.reply_markup || {}),
      ...(keyboard?.reply_markup || {})
    }
  };
}

function inlineKeyboard(inlineKeyboardRows) {
  return { reply_markup: { inline_keyboard: inlineKeyboardRows } };
}

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

function countRules(value) {
  return Array.isArray(value) ? value.length : 0;
}

function formatTemplateLines(templates, options = {}) {
  const visible = options.includeDisabled ? templates : templates.filter((template) => template.enabled !== false);
  if (!visible.length) return ['- none'];
  return visible.slice(0, 12).map((template) => {
    const status = template.enabled === false ? 'disabled' : 'enabled';
    const schedule = formatSchedule(template.schedule);
    const window = template.windowHours ? `, window=${template.windowHours}h` : '';
    return `- ${template.key || '<missing key>'}: ${status}, source=${template.source || '<missing source>'}, ${schedule}${window}`;
  });
}

function formatSchedule(schedule) {
  if (!schedule) return 'schedule=missing';
  if (schedule.type === 'daily') return `daily ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'weekly') return `weekly day ${schedule.weekday ?? '?'} ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'monthly') return `monthly day ${schedule.dayOfMonth ?? '?'} ${schedule.time || '<missing time>'}`;
  return `${schedule.type || '<missing type>'} ${schedule.time || '<missing time>'}`;
}

function getEffectiveGlobalFirstSendAt(publish) {
  return publish?.firstSendAt ? String(publish.firstSendAt) : '';
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function findScheduleConflicts(templates) {
  const enabled = templates.filter((template) => template.enabled !== false && template.schedule);
  const groups = new Map();
  for (const template of enabled) {
    const key = scheduleIdentity(template.schedule);
    groups.set(key, [...(groups.get(key) || []), template.key || '<missing key>']);
  }
  return [...groups.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([schedule, keys]) => `${schedule} is used by ${keys.join(', ')}`);
}

function scheduleIdentity(schedule) {
  if (!schedule) return 'missing schedule';
  if (schedule.type === 'daily') return `daily:${schedule.time || ''}`;
  if (schedule.type === 'weekly') return `weekly:${schedule.weekday || ''}:${schedule.time || ''}`;
  if (schedule.type === 'monthly') return `monthly:${schedule.dayOfMonth || ''}:${schedule.time || ''}`;
  return `${schedule.type || ''}:${schedule.time || ''}`;
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function getArgument(text = '') {
  return text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
}

function splitFirstArgument(text) {
  const argument = getArgument(text);
  const match = argument.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? [match[1], match[2]] : [argument, ''];
}

function parseLimit(text, fallback) {
  const raw = getArgument(text);
  if (!raw) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Limit must be an integer from 1 to 1000');
  }
  return limit;
}

function parseMessageId(text) {
  const raw = getArgument(text);
  const messageId = Number(raw);
  if (!Number.isInteger(messageId) || messageId < 1) {
    throw new Error('Message id must be a positive integer');
  }
  return messageId;
}

function parsePreviewArgs(text) {
  const raw = getArgument(text);
  if (!raw) return { postCount: DEFAULT_PREVIEW_POSTS, messageCount: DEFAULT_PREVIEW_MESSAGES };
  const parts = raw.split(/\s+/).map(Number);
  const [postCount, messageCount = DEFAULT_PREVIEW_MESSAGES] = parts;

  if (!Number.isInteger(postCount) || postCount < 1 || postCount > 20) {
    throw new Error('Post count must be an integer from 1 to 20');
  }
  if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 1000) {
    throw new Error('Message count must be an integer from 1 to 1000');
  }
  return { postCount, messageCount };
}

async function replyCode(ctx, text) {
  const limit = 3400;
  for (let index = 0; index < text.length; index += limit) {
    const chunk = text.slice(index, index + limit);
    await ctx.reply(`<pre><code>${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

async function replyJsonCode(ctx, value) {
  const json = stringifyForSetup(value);
  const chunkSize = 3400;
  for (let index = 0; index < json.length; index += chunkSize) {
    const chunk = json.slice(index, index + chunkSize);
    await ctx.reply(`<pre><code class="language-json">${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

async function replyJsonFile(ctx, value, filename) {
  const json = stringifyForSetup(value);
  await ctx.replyWithDocument({
    source: Buffer.from(`${json}\n`, 'utf8'),
    filename
  });
}

export function stringifyForSetup(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  }, 2) ?? 'null';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
