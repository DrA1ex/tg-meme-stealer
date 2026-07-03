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
import { parseMessagesToPosts } from '../core/postParser.js';
import { loadConfig } from '../config/index.js';
import { sendRichPost } from './richPost.js';
import {
  ADVANCED_HELP,
  DEFAULT_PREVIEW_MESSAGES,
  DEFAULT_PREVIEW_POSTS,
  DEFAULT_SAMPLE_MAX_MESSAGES,
  DEFAULT_SAMPLE_MIN_MATCHED,
  DEFAULT_SAMPLE_STEP_MESSAGES,
  DEFAULT_TEST_MESSAGES
} from './setup/constants.js';
import {
  formatConfirmResetFilters,
  formatLastChange,
  formatNoLastChange,
  formatParserMenu,
  formatFiltersMenu,
  formatAuthorMenu,
  formatReactionsMenu,
  formatTechnicalDiagnosticsMenu,
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
  formatSuggestionOptions,
  filterSuggestionsByCategory,
  getSuggestionCategory,
  formatFiltersReset,
  confirmResetFiltersKeyboard,
  isSuggestionUseful,
  markSuggestionStates,
  toggleFilterSuggestion,
  parserSuggestionsKeyboard,
  suggestionOptionsKeyboard
} from './setup/parserSuggestions.js';
import {
  formatAuthorExtractionTest,
  formatFilterImpact,
  formatParserPaths,
  formatReactionExtractionTest
} from './setup/parserDiagnostics.js';
import {
  buildCompactRawMessage,
  findDiagnosticMessage,
  findDiagnosticMessages,
  formatCompactRawMessageScreen,
  formatAuthorFields,
  formatFieldScan,
  formatMessageShape,
  formatMessageBrowser,
  formatParserTrace,
  formatReactionFields,
  formatTechnicalMessagePreview,
  formatTechnicalDiagnosticsOverview
} from './setup/technicalDiagnostics.js';
import {
  buildDatabaseTrafficScheduleSuggestions,
  buildRecentTrafficScheduleSuggestions,
  formatScheduleDoctor,
  formatSchedulePreview,
  formatTrafficScheduleSuggestions,
  getMaxTrafficDays
} from './setup/scheduleDiagnostics.js';
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
  findPublishTemplate,
  formatConfirmRemovePublishTemplate,
  formatManagePublishTemplates,
  formatPublishTemplateChanged,
  getPublishTemplates,
  removePublishTemplate,
  setPublishTemplateEnabled
} from './setup/publishTemplates.js';
import { formatSourceExpressionTest } from './setup/sourceDiagnostics.js';
import { applySourcePreset, formatAppliedSourcePreset, formatCustomSourceHelp, formatResetSources, formatSourcesMenu, getSourcePreset, parseCustomSourceInput, parseSourceTextCommand, resetDraftSources } from './setup/sourcePresets.js';
import { applyManualSchedule, createScheduleWizard, formatManualScheduleApplied, formatManualScheduleConfirm, formatManualScheduleWizard, getWizardNextStep, normalizeWizardStep } from './setup/scheduleWizard.js';
import {
  advancedMenuKeyboard,
  button,
  authorMenuKeyboard,
  filtersMenuKeyboard,
  reactionsMenuKeyboard,
  technicalDiagnosticsKeyboard,
  technicalDiagnosticsBackKeyboard,
  technicalTraceKeyboard,
  technicalRawKeyboard,
  technicalMessageBrowserKeyboard,
  technicalMessagePreviewKeyboard,
  confirmReplacePublishPresetKeyboard,
  confirmRemoveTemplateKeyboard,
  manageTemplatesKeyboard,
  mergeReplyOptions,
  parserMenuKeyboard,
  previewMenuKeyboard,
  publishAfterPresetKeyboard,
  publishMenuKeyboard,
  sourcesKeyboard,
  sourceCustomInputKeyboard,
  manualScheduleKeyboard,
  publishPresetDetailsKeyboard,
  publishPresetsKeyboard,
  setupMenuKeyboard,
  trafficSuggestionsKeyboard
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
    this.setupTrafficPresets = new Map();
    this.setupSampleCache = new Map();
    this.setupCurrentView = new Map();
    this.setupScheduleWizards = new Map();
    this.setupTextPrompts = new Map();
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
    bot.on('text', (ctx) => this.handleSetupText(ctx));
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
    if (action === 'filters') {
      this.ensureSession(ctx);
      await this.filtersMenu(ctx);
      return;
    }
    if (action === 'filters_options') {
      this.ensureSession(ctx);
      await this.filterOptions(ctx);
      return;
    }
    if (action === 'author') {
      this.ensureSession(ctx);
      await this.authorMenu(ctx);
      return;
    }
    if (action === 'author_options') {
      this.ensureSession(ctx);
      await this.authorOptions(ctx);
      return;
    }
    if (action === 'reactions') {
      this.ensureSession(ctx);
      await this.reactionsMenu(ctx);
      return;
    }
    if (action === 'reaction_options') {
      this.ensureSession(ctx);
      await this.reactionOptions(ctx);
      return;
    }
    if (action.startsWith('load_more:')) {
      this.ensureSession(ctx);
      await this.loadMoreMessages(ctx, action.slice('load_more:'.length));
      return;
    }
    if (action === 'technical') {
      this.ensureSession(ctx);
      await this.technicalDiagnostics(ctx);
      return;
    }
    if (action.startsWith('technical_')) {
      this.ensureSession(ctx);
      await this.technicalAction(ctx, action);
      return;
    }
    if (action.startsWith('refresh_sample')) {
      this.ensureSession(ctx);
      await this.refreshSample(ctx, action.includes(':') ? action.split(':').slice(1).join(':') : 'technical');
      return;
    }
    if (action === 'reset_author') {
      this.ensureSession(ctx);
      await this.resetAuthor(ctx);
      return;
    }
    if (action === 'reset_reactions') {
      this.ensureSession(ctx);
      await this.resetReactions(ctx);
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
    if (action === 'parser_paths') {
      this.ensureSession(ctx);
      await this.parserPaths(ctx);
      return;
    }
    if (action === 'author_test') {
      this.ensureSession(ctx);
      await this.authorTest(ctx);
      return;
    }
    if (action === 'reaction_test') {
      this.ensureSession(ctx);
      await this.reactionTest(ctx);
      return;
    }
    if (action === 'filter_impact') {
      this.ensureSession(ctx);
      await this.filterImpact(ctx);
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
    if (action === 'schedule_preview') {
      this.ensureSession(ctx);
      await this.schedulePreview(ctx);
      return;
    }
    if (action === 'schedule_doctor') {
      this.ensureSession(ctx);
      await this.scheduleDoctor(ctx);
      return;
    }
    if (action === 'traffic_suggestions') {
      this.ensureSession(ctx);
      await this.trafficSuggestions(ctx);
      return;
    }
    if (action === 'traffic_week') {
      this.ensureSession(ctx);
      await this.extendedTrafficSuggestions(ctx, 7);
      return;
    }
    if (action === 'traffic_month') {
      this.ensureSession(ctx);
      await this.extendedTrafficSuggestions(ctx, 30);
      return;
    }
    if (action === 'traffic_max') {
      this.ensureSession(ctx);
      await this.extendedTrafficSuggestions(ctx, getMaxTrafficDays(this.config));
      return;
    }
    if (action === 'manage_templates') {
      this.ensureSession(ctx);
      await this.manageTemplates(ctx);
      return;
    }
    if (action === 'source_test') {
      this.ensureSession(ctx);
      await this.sourceTest(ctx);
      return;
    }
    if (action === 'sources') {
      this.ensureSession(ctx);
      await this.sourcesMenu(ctx);
      return;
    }
    if (action === 'source_custom') {
      this.ensureSession(ctx);
      await this.sourceCustomHelp(ctx);
      return;
    }
    if (action === 'source_custom_cancel') {
      this.ensureSession(ctx);
      this.setupTextPrompts.delete(ctx.from.id);
      await this.sourcesMenu(ctx);
      return;
    }
    if (action === 'sources_reset') {
      this.ensureSession(ctx);
      await this.resetSources(ctx);
      return;
    }
    if (action === 'manual_schedule') {
      this.ensureSession(ctx);
      await this.startManualSchedule(ctx);
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
      } else if (action === 'filters') {
        await this.filtersMenu(ctx);
      } else if (action === 'filters_options') {
        await this.filterOptions(ctx);
      } else if (action === 'author') {
        await this.authorMenu(ctx);
      } else if (action === 'author_options') {
        await this.authorOptions(ctx);
      } else if (action === 'reactions') {
        await this.reactionsMenu(ctx);
      } else if (action === 'reaction_options') {
        await this.reactionOptions(ctx);
      } else if (action.startsWith('load_more:')) {
        await this.loadMoreMessages(ctx, action.slice('load_more:'.length));
      } else if (action === 'technical') {
        await this.technicalDiagnostics(ctx);
      } else if (action.startsWith('technical_')) {
        await this.technicalAction(ctx, action);
      } else if (action.startsWith('refresh_sample')) {
        await this.refreshSample(ctx, action.includes(':') ? action.split(':').slice(1).join(':') : 'technical');
      } else if (action === 'reset_author') {
        await this.resetAuthor(ctx);
      } else if (action === 'reset_reactions') {
        await this.resetReactions(ctx);
      } else if (action === 'parser_config') {
        await this.showParserConfig(ctx);
      } else if (action === 'suggest') {
        await this.suggestParser(ctx);
      } else if (action === 'parser_paths') {
        await this.parserPaths(ctx);
      } else if (action === 'author_test') {
        await this.authorTest(ctx);
      } else if (action === 'reaction_test') {
        await this.reactionTest(ctx);
      } else if (action === 'filter_impact') {
        await this.filterImpact(ctx);
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
      } else if (action === 'schedule_preview') {
        await this.schedulePreview(ctx);
      } else if (action === 'schedule_doctor') {
        await this.scheduleDoctor(ctx);
      } else if (action === 'traffic_suggestions') {
        await this.trafficSuggestions(ctx);
      } else if (action.startsWith('traffic_extended:')) {
        await this.extendedTrafficSuggestions(ctx, Number(action.slice('traffic_extended:'.length)));
      } else if (action.startsWith('traffic_apply:')) {
        await this.applyTrafficPreset(ctx, action.slice('traffic_apply:'.length));
      } else if (action === 'manage_templates') {
        await this.manageTemplates(ctx);
      } else if (action.startsWith('template_enable:')) {
        await this.setTemplateEnabled(ctx, action.slice('template_enable:'.length), true);
      } else if (action.startsWith('template_disable:')) {
        await this.setTemplateEnabled(ctx, action.slice('template_disable:'.length), false);
      } else if (action.startsWith('template_remove:')) {
        await this.confirmRemoveTemplate(ctx, action.slice('template_remove:'.length));
      } else if (action.startsWith('template_remove_confirm:')) {
        await this.removeTemplate(ctx, action.slice('template_remove_confirm:'.length));
      } else if (action === 'sources') {
        await this.sourcesMenu(ctx);
      } else if (action.startsWith('source_preset:')) {
        await this.applySourcePresetAction(ctx, action.slice('source_preset:'.length));
      } else if (action === 'source_custom') {
        await this.sourceCustomHelp(ctx);
      } else if (action === 'source_custom_cancel') {
        this.setupTextPrompts.delete(ctx.from.id);
        await this.sourcesMenu(ctx);
      } else if (action === 'sources_reset') {
        await this.resetSources(ctx);
      } else if (action === 'manual_schedule') {
        await this.startManualSchedule(ctx);
      } else if (action.startsWith('manual_source:')) {
        await this.manualScheduleSet(ctx, { source: action.slice('manual_source:'.length) });
      } else if (action.startsWith('manual_cadence:')) {
        await this.manualScheduleSet(ctx, { cadence: action.slice('manual_cadence:'.length), weekdays: [], dayOfMonth: null, time: '', windowHours: null });
      } else if (action.startsWith('manual_weekday:')) {
        await this.manualScheduleSet(ctx, { weekdays: [Number(action.slice('manual_weekday:'.length))] });
      } else if (action.startsWith('manual_weekdays:')) {
        await this.manualScheduleSet(ctx, { weekdays: action.slice('manual_weekdays:'.length).split(',').map(Number) });
      } else if (action.startsWith('manual_monthday:')) {
        await this.manualScheduleSet(ctx, { dayOfMonth: Number(action.slice('manual_monthday:'.length)) });
      } else if (action.startsWith('manual_time:')) {
        await this.manualScheduleSet(ctx, { time: action.slice('manual_time:'.length) });
      } else if (action.startsWith('manual_window:')) {
        await this.manualScheduleSet(ctx, { windowHours: Number(action.slice('manual_window:'.length)) });
      } else if (action.startsWith('manual_posts:')) {
        await this.manualScheduleSet(ctx, { postsPreset: action.slice('manual_posts:'.length) });
      } else if (action.startsWith('manual_threshold:')) {
        await this.manualScheduleSet(ctx, { thresholdPreset: action.slice('manual_threshold:'.length) });
      } else if (action === 'manual_create') {
        await this.createManualSchedule(ctx);
      } else if (action === 'source_test') {
        await this.sourceTest(ctx);
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
    this.setupTrafficPresets.delete(ctx.from.id);
    this.setupSampleCache.delete(ctx.from.id);
    this.setupCurrentView.delete(ctx.from.id);
    this.setupScheduleWizards.delete(ctx.from.id);
    this.setupTextPrompts.delete(ctx.from.id);
    await this.replyWithKeyboard(ctx, formatSetupIntro(this.getDraft(ctx), this.getMeta(ctx)), setupMenuKeyboard());
  }

  async status(ctx) {
    await this.replyWithKeyboard(ctx, formatSetupStatus(this.getDraft(ctx), this.config, this.getMeta(ctx)), setupMenuKeyboard());
  }

  async parserMenu(ctx) {
    this.rememberCurrentView(ctx, 'parser');
    await this.replyWithKeyboard(ctx, formatParserMenu(this.getDraft(ctx)), parserMenuKeyboard());
  }
  async filtersMenu(ctx) {
    this.rememberCurrentView(ctx, 'filters');
    await this.replyWithKeyboard(ctx, formatFiltersMenu(this.getDraft(ctx)), filtersMenuKeyboard());
  }

  async authorMenu(ctx) {
    this.rememberCurrentView(ctx, 'author');
    await this.replyWithKeyboard(ctx, formatAuthorMenu(this.getDraft(ctx)), authorMenuKeyboard());
  }

  async reactionsMenu(ctx) {
    this.rememberCurrentView(ctx, 'reactions');
    await this.replyWithKeyboard(ctx, formatReactionsMenu(this.getDraft(ctx)), reactionsMenuKeyboard());
  }

  async technicalDiagnostics(ctx) {
    this.rememberCurrentView(ctx, 'technical');
    const result = await this.collectSetupSample(ctx, { purpose: 'technical diagnostics', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatTechnicalDiagnosticsOverview({
      messages: result.messages || [],
      draft: this.getDraft(ctx),
      baseConfig: this.config,
      sample: this.getSampleStatus(ctx, result)
    }), technicalDiagnosticsKeyboard());
  }

  async technicalAction(ctx, action) {
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

  async technicalFieldScan(ctx) {
    this.rememberCurrentView(ctx, 'technical_field_scan');
    const result = await this.collectSetupSample(ctx, { purpose: 'field scan', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatFieldScan(result.messages || []), technicalDiagnosticsBackKeyboard('technical_field_scan'));
  }

  async technicalMessageShape(ctx) {
    this.rememberCurrentView(ctx, 'technical_shape');
    const result = await this.collectSetupSample(ctx, { purpose: 'message shape diagnostics', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatMessageShape(result.messages || []), technicalDiagnosticsBackKeyboard('technical_shape'));
  }

  async technicalReactionFields(ctx) {
    this.rememberCurrentView(ctx, 'technical_reactions');
    const result = await this.collectSetupSample(ctx, { purpose: 'reaction field diagnostics', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatReactionFields(result.messages || []), technicalDiagnosticsBackKeyboard('technical_reactions'));
  }

  async technicalAuthorFields(ctx) {
    this.rememberCurrentView(ctx, 'technical_author');
    const result = await this.collectSetupSample(ctx, { purpose: 'author field diagnostics', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatAuthorFields(result.messages || []), technicalDiagnosticsBackKeyboard('technical_author'));
  }

  async technicalTrace(ctx, mode = 'matched', index = 0) {
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

  async technicalRaw(ctx, mode = 'matched', index = 0) {
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

  async technicalMessageBrowser(ctx, page = 0) {
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

  async technicalPreviewMessage(ctx, messageId, page = 0) {
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


  async technicalSendPreviewMessage(ctx, messageId, page = 0) {
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


  async publishMenu(ctx) {
    this.rememberCurrentView(ctx, 'publish');
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

    await this.applyPublishPresetObject(ctx, preset, { replace, validationKeyboard: publishPresetDetailsKeyboard(preset) });
  }

  async applyPublishPresetObject(ctx, preset, { replace = false, validationKeyboard = publishMenuKeyboard() } = {}) {
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
        validationKeyboard
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
    await this.replyWithKeyboard(ctx, 'Use Test content or Preview to check these rules against real source posts.', parserMenuKeyboard());
  }

  async doctor(ctx) {
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'setup doctor', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatSetupDoctor({ draft, baseConfig: this.config, preview: result }), setupMenuKeyboard());
  }

  async testDefaults(ctx) {
    const result = await this.collectSetupSample(ctx, { purpose: 'parser test' });
    await replyCode(ctx, summarizeParsedPosts(result, { maxRows: 12 }));
    this.markTested(ctx);
    await this.replyWithKeyboard(ctx, 'Content test finished.', parserMenuKeyboard());
  }

  async previewDefaults(ctx) {
    await this.sendPreview(ctx, {
      postCount: DEFAULT_PREVIEW_POSTS,
      messageCount: DEFAULT_PREVIEW_MESSAGES
    });
  }

  async suggestParser(ctx) {
    this.rememberCurrentView(ctx, 'suggest');
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'parser suggestions', includeMessages: true });
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

  async filterOptions(ctx) {
    this.rememberCurrentView(ctx, 'filters_options');
    await this.suggestionOptions(ctx, 'filters', {
      purpose: 'filter options',
      title: 'Filter options',
      icon: '🔎',
      categoryTitle: '✨ Filter options',
      back: 'setup:filters',
      next: 'Choose filters, then run Filter impact or Test content.'
    });
  }

  async authorOptions(ctx) {
    this.rememberCurrentView(ctx, 'author_options');
    await this.suggestionOptions(ctx, 'author', {
      purpose: 'author options',
      title: 'Author options',
      icon: '👤',
      categoryTitle: '✨ Author options',
      back: 'setup:author',
      next: 'Choose one author mode, then run Test author.'
    });
  }

  async reactionOptions(ctx) {
    this.rememberCurrentView(ctx, 'reaction_options');
    await this.suggestionOptions(ctx, 'reactions', {
      purpose: 'reaction options',
      title: 'Reaction options',
      icon: '👍',
      categoryTitle: '✨ Reaction options',
      back: 'setup:reactions',
      next: 'Choose one reaction mode, then run Test reactions.'
    });
  }

  async suggestionOptions(ctx, category, options) {
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: options.purpose, includeMessages: true });
    const suggestions = buildParserSuggestions(result.messages || [], draft);
    this.setupSuggestions.set(ctx.from.id, suggestions);
    const states = markSuggestionStates(filterSuggestionsByCategory(suggestions, category), draft);
    await this.replaceCurrentSetupMessage(
      ctx,
      formatSuggestionOptions({
        title: options.title,
        icon: options.icon,
        categoryTitle: options.categoryTitle,
        suggestions: states,
        scanned: result.scanned,
        matched: result.posts.length,
        next: options.next
      }),
      suggestionOptionsKeyboard(states, { back: options.back, extraRows: getCategoryExtraRows(category), loadMoreTarget: options.loadMoreTarget || `${category}_options` })
    );
  }

  async parserPaths(ctx) {
    this.rememberCurrentView(ctx, 'parser_paths');
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'parser paths', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatParserPaths(result.messages || [], draft), technicalDiagnosticsKeyboard());
  }

  async authorTest(ctx) {
    this.rememberCurrentView(ctx, 'author_test');
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'author extraction test', includeMessages: true });
    this.markTested(ctx);
    await this.replyWithKeyboard(ctx, formatAuthorExtractionTest({
      messages: result.messages || [],
      draft,
      baseConfig: this.config
    }), authorMenuKeyboard());
  }

  async reactionTest(ctx) {
    this.rememberCurrentView(ctx, 'reaction_test');
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'reaction extraction test', includeMessages: true });
    this.markTested(ctx);
    await this.replyWithKeyboard(ctx, formatReactionExtractionTest({
      messages: result.messages || [],
      draft,
      baseConfig: this.config
    }), reactionsMenuKeyboard());
  }

  async filterImpact(ctx) {
    this.rememberCurrentView(ctx, 'filter_impact');
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, { purpose: 'filter impact', includeMessages: true });
    await this.replyWithKeyboard(ctx, formatFilterImpact({
      messages: result.messages || [],
      draft,
      baseConfig: this.config
    }), suggestionOptionsKeyboard(markSuggestionStates(filterSuggestionsByCategory(buildParserSuggestions(result.messages || [], draft), 'filters'), draft), { back: 'setup:filters', extraRows: getCategoryExtraRows('filters'), loadMoreTarget: 'filter_impact' }));
  }

  async schedulePreview(ctx) {
    await this.replyWithKeyboard(ctx, formatSchedulePreview(this.getDraft(ctx), this.config), publishMenuKeyboard());
  }

  async scheduleDoctor(ctx) {
    await this.replyWithKeyboard(ctx, formatScheduleDoctor(this.getDraft(ctx), this.config), publishMenuKeyboard());
  }

  async trafficSuggestions(ctx) {
    const draft = this.getDraft(ctx);
    const result = await this.collectSetupSample(ctx, {
      purpose: 'recent traffic suggestions',
      initialLimit: DEFAULT_PREVIEW_MESSAGES,
      minMatched: DEFAULT_SAMPLE_MIN_MATCHED,
      step: DEFAULT_SAMPLE_STEP_MESSAGES,
      maxLimit: Math.max(DEFAULT_PREVIEW_MESSAGES, DEFAULT_SAMPLE_MAX_MESSAGES),
      includeMessages: true
    });
    const report = buildRecentTrafficScheduleSuggestions({
      messages: result.messages || [],
      draft,
      baseConfig: this.config
    });
    this.setupTrafficPresets.set(ctx.from.id, report.presets || []);
    await this.replyWithKeyboard(ctx, formatTrafficScheduleSuggestions(report), trafficSuggestionsKeyboard(report.presets || [], { maxDays: getMaxTrafficDays(this.config) }));
  }

  async extendedTrafficSuggestions(ctx, days) {
    const safeDays = Math.min(getMaxTrafficDays(this.config), Math.max(1, Number(days || 7)));
    const report = await buildDatabaseTrafficScheduleSuggestions({
      repository: this.scanner.repository,
      draft: this.getDraft(ctx),
      baseConfig: this.config,
      days: safeDays
    });
    this.setupTrafficPresets.set(ctx.from.id, report.presets || []);
    await this.replyWithKeyboard(ctx, formatTrafficScheduleSuggestions(report), trafficSuggestionsKeyboard(report.presets || [], { maxDays: getMaxTrafficDays(this.config) }));
  }

  async applyTrafficPreset(ctx, presetId) {
    const presets = this.setupTrafficPresets.get(ctx.from.id) || [];
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) {
      await this.replyWithKeyboard(ctx, 'Traffic preset is no longer available. Run Traffic suggestions again.', trafficSuggestionsKeyboard([], { maxDays: getMaxTrafficDays(this.config) }));
      return;
    }

    await this.applyPublishPresetObject(ctx, preset, { replace: false });
  }

  async manageTemplates(ctx) {
    const draft = this.getDraft(ctx);
    await this.replyWithKeyboard(ctx, formatManagePublishTemplates(draft), manageTemplatesKeyboard(getPublishTemplates(draft)));
  }

  async setTemplateEnabled(ctx, key, enabled) {
    const draft = this.getDraft(ctx);
    const beforePublish = structuredClone(draft.publish || {});
    setPublishTemplateEnabled(draft, key, enabled);
    const afterPublish = structuredClone(draft.publish || {});
    const action = enabled ? 'Enabled publish template' : 'Disabled publish template';
    const detail = formatPublishChanges(beforePublish, afterPublish);
    this.markChanged(ctx, 'publishing', `${action}: ${key}`, detail);
    await this.replyWithKeyboard(
      ctx,
      formatPublishTemplateChanged({ beforePublish, afterPublish, action, key }),
      manageTemplatesKeyboard(getPublishTemplates(draft))
    );
  }

  async confirmRemoveTemplate(ctx, key) {
    await this.replyWithKeyboard(
      ctx,
      formatConfirmRemovePublishTemplate(this.getDraft(ctx), key),
      confirmRemoveTemplateKeyboard(key)
    );
  }

  async removeTemplate(ctx, key) {
    const draft = this.getDraft(ctx);
    if (!findPublishTemplate(draft, key)) {
      await this.replyWithKeyboard(ctx, `Publish template not found: ${key}`, manageTemplatesKeyboard(getPublishTemplates(draft)));
      return;
    }
    const beforePublish = structuredClone(draft.publish || {});
    removePublishTemplate(draft, key);
    const afterPublish = structuredClone(draft.publish || {});
    const detail = formatPublishChanges(beforePublish, afterPublish);
    this.markChanged(ctx, 'publishing', `Removed publish template: ${key}`, detail);
    await this.replyWithKeyboard(
      ctx,
      formatPublishTemplateChanged({ beforePublish, afterPublish, action: 'Removed publish template', key }),
      manageTemplatesKeyboard(getPublishTemplates(draft))
    );
  }

  async sourceTest(ctx) {
    await this.replyWithKeyboard(ctx, await formatSourceExpressionTest({
      repository: this.scanner.repository,
      draft: this.getDraft(ctx),
      baseConfig: this.config
    }), publishMenuKeyboard());
  }
  async sourcesMenu(ctx) {
    this.rememberCurrentView(ctx, 'sources');
    await this.replyWithKeyboard(ctx, formatSourcesMenu(this.getDraft(ctx), this.config), sourcesKeyboard(this.getDraft(ctx)));
  }

  async applySourcePresetAction(ctx, presetId) {
    const preset = getSourcePreset(presetId);
    if (!preset) {
      await this.replyWithKeyboard(ctx, 'Unknown source preset. Choose one from Sources.', sourcesKeyboard(this.getDraft(ctx)));
      return;
    }
    const change = applySourcePreset(this.getDraft(ctx), preset);
    this.markChanged(ctx, 'publishing', `${change.action === 'removed' ? 'Removed' : 'Selected'} source preset: ${preset.key}`, change.lines);
    await this.replyWithKeyboard(ctx, formatAppliedSourcePreset(preset, change), sourcesKeyboard(this.getDraft(ctx)));
  }

  async sourceCustomHelp(ctx, error = '') {
    this.setupTextPrompts.set(ctx.from.id, { kind: 'source_custom' });
    await this.replyWithKeyboard(ctx, formatCustomSourceHelp(error), sourceCustomInputKeyboard());
  }

  async resetSources(ctx) {
    const change = resetDraftSources(this.getDraft(ctx));
    this.markChanged(ctx, 'publishing', 'Reset draft publish sources', change.lines);
    await this.replyWithKeyboard(ctx, formatResetSources(change), sourcesKeyboard(this.getDraft(ctx)));
  }

  async startManualSchedule(ctx) {
    const wizard = createScheduleWizard(this.getDraft(ctx), this.config);
    this.setupScheduleWizards.set(ctx.from.id, wizard);
    await this.showManualScheduleStep(ctx, 'source');
  }

  async manualScheduleSet(ctx, patch = {}) {
    const wizard = this.getManualScheduleWizard(ctx);
    if (Object.prototype.hasOwnProperty.call(patch, 'source') && wizard.source === patch.source) {
      wizard.source = '';
    } else {
      Object.assign(wizard, patch);
    }
    this.setupScheduleWizards.set(ctx.from.id, wizard);
    await this.showManualScheduleStep(ctx, getWizardNextStep(wizard));
  }

  async showManualScheduleStep(ctx, step = '') {
    const wizard = this.getManualScheduleWizard(ctx);
    const normalizedStep = normalizeWizardStep(step || getWizardNextStep(wizard));
    await this.replyWithKeyboard(
      ctx,
      normalizedStep === 'confirm'
      ? formatManualScheduleConfirm(wizard)
      : formatManualScheduleWizard({ wizard, draft: this.getDraft(ctx), baseConfig: this.config, step: normalizedStep }),
      manualScheduleKeyboard({ draft: this.getDraft(ctx), baseConfig: this.config, wizard, step: normalizedStep })
    );
  }

  async createManualSchedule(ctx) {
    const wizard = this.getManualScheduleWizard(ctx);
    const change = applyManualSchedule(this.getDraft(ctx), wizard);
    this.markChanged(ctx, 'publishing', 'Created custom schedule', change.lines);
    this.setupScheduleWizards.delete(ctx.from.id);
    await this.replyWithKeyboard(ctx, formatManualScheduleApplied(change), publishAfterPresetKeyboard());
  }

  getManualScheduleWizard(ctx) {
    if (!this.setupScheduleWizards.has(ctx.from.id)) {
      this.setupScheduleWizards.set(ctx.from.id, createScheduleWizard(this.getDraft(ctx), this.config));
    }
    return this.setupScheduleWizards.get(ctx.from.id);
  }


  async loadMoreMessages(ctx, target = '') {
    const normalizedTarget = normalizeLoadMoreTarget(target, this.getCurrentView(ctx));
    await this.collectSetupSample(ctx, {
      purpose: `load more for ${formatLoadMoreTarget(normalizedTarget)}`,
      includeMessages: true,
      forceLoadMore: true,
      minMatched: Number.POSITIVE_INFINITY
    });
    await this.showLoadMoreTarget(ctx, normalizedTarget);
  }

  async showLoadMoreTarget(ctx, target) {
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
    if (target.startsWith('technical_preview')) return this.technicalMessageBrowser(ctx, Number(target.split(':')[1] || 0));
    if (target === 'test') return this.testDefaults(ctx);
    return this.suggestParser(ctx);
  }

  async refreshSample(ctx, target = '') {
    const normalizedTarget = normalizeLoadMoreTarget(target, this.getCurrentView(ctx));
    this.setupSampleCache.delete(ctx.from.id);
    await this.showLoadMoreTarget(ctx, normalizedTarget);
  }

  async collectSetupSample(ctx, {
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

  getSampleStatus(ctx, result = {}) {
    const cache = this.setupSampleCache.get(ctx.from.id);
    return {
      maxLimit: DEFAULT_SAMPLE_MAX_MESSAGES,
      exhausted: Boolean(result.exhausted ?? cache?.exhausted),
      cacheAgeMs: cache?.loadedAt ? Date.now() - Number(cache.loadedAt) : null
    };
  }

  getUsableSampleCache(ctx, maxMessages) {
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
    const filterToggleAction = suggestion.filterRules?.length ? toggleFilterSuggestion(draft, suggestion) : null;
    if (!filterToggleAction) suggestion.apply(draft);
    const afterParsing = structuredClone(draft.parsing || {});
    const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
    this.markChanged(ctx, 'parser', `${filterToggleAction === 'removed' ? 'Removed filter suggestion' : 'Applied parser suggestion'}: ${suggestion.title}`, detail);
    if (filterToggleAction) {
      await this.filterOptions(ctx);
      return;
    }
    await this.replyWithKeyboard(
      ctx,
      [
        formatAppliedSuggestion({
          suggestion,
          beforeParsing,
          afterParsing
        }),
        '',
        'You can apply another suggestion from the same list, or run Test content / Preview.'
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

  async resetAuthor(ctx) {
    const draft = this.getDraft(ctx);
    const beforeParsing = structuredClone(draft.parsing || {});
    draft.parsing.author = [];
    const afterParsing = structuredClone(draft.parsing || {});
    const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
    this.markChanged(ctx, 'parser', 'Reset author extraction', detail);
    await this.replyWithKeyboard(ctx, [
      '✅ Author rules reset.',
      '',
      'Open Author options to choose a new author extraction mode.'
    ].join('\n'), authorMenuKeyboard());
  }

  async resetReactions(ctx) {
    const draft = this.getDraft(ctx);
    const beforeParsing = structuredClone(draft.parsing || {});
    draft.parsing.likes = [];
    draft.parsing.dislikes = [];
    const afterParsing = structuredClone(draft.parsing || {});
    const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
    this.markChanged(ctx, 'parser', 'Reset reaction parsing', detail);
    await this.replyWithKeyboard(ctx, [
      '✅ Reaction rules reset.',
      '',
      'Open Reaction options to choose button counters or native reactions.'
    ].join('\n'), reactionsMenuKeyboard());
  }

  async setRules(ctx, key) {
    const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
    const rules = parseJsonArgument(ctx.message.text);
    setParsingRules(this.getDraft(ctx), key, rules);
    this.markChanged(ctx, 'parser', `${key} replaced`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
    await this.replyWithKeyboard(ctx, `${key} replaced. Use Test content or Preview to check the result.`, parserMenuKeyboard());
  }

  async addRules(ctx, key) {
    const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
    const rules = parseJsonArgument(ctx.message.text);
    addParsingRule(this.getDraft(ctx), key, rules);
    this.markChanged(ctx, 'parser', `${key} appended`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
    await this.replyWithKeyboard(ctx, `${key} appended. Use Test content or Preview to check the result.`, parserMenuKeyboard());
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
    let source;
    try {
      source = parseSourceTextCommand(ctx.message.text);
    } catch (error) {
      await this.sourceCustomHelp(ctx, error.message);
      return;
    }
    upsertPublishSource(this.getDraft(ctx), source);
    this.markChanged(ctx, 'publishing', `publish.sources.${source.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
    await this.replyWithKeyboard(ctx, `publish.sources.${source.key} updated. Run Source test or Save when ready.`, sourcesKeyboard(this.getDraft(ctx)));
  }

  async setPublish(ctx) {
    const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
    const template = parseJsonArgument(ctx.message.text);
    setPublishTemplate(this.getDraft(ctx), template);
    this.markChanged(ctx, 'publishing', `publish.template.${template.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
    await this.replyWithKeyboard(ctx, `publish.template.${template.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async test(ctx) {
    const hasExplicitLimit = Boolean(getArgument(ctx.message.text));
    const result = hasExplicitLimit
                   ? await this.scanner.previewRecent(parseLimit(ctx.message.text, DEFAULT_TEST_MESSAGES), this.getDraft(ctx))
                   : await this.collectSetupSample(ctx, { purpose: 'parser test' });
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
      'If the match set is wrong, use Content setup → Quick setup or Advanced JSON.'
    ].join('\n'), previewMenuKeyboard());

    if (!posts.length) {
      await this.replyWithKeyboard(ctx, formatPreviewPost(null, draft.templates), previewMenuKeyboard());
      return;
    }

    const progress = await ctx.reply(formatPreviewProgress({ total: posts.length, sent: 0 }));
    try {
      for (let index = 0; index < posts.length; index += 1) {
        await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, formatPreviewProgress({
          total: posts.length,
          sent: index,
          current: index + 1
        })).catch(() => {});
        await sendRichPost({
          telegram: ctx.telegram,
          chatId: ctx.chat.id,
          mediaDownloader: this.mediaDownloader,
          post: posts[index],
          index,
          templates: draft.templates
        });
        await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, formatPreviewProgress({
          total: posts.length,
          sent: index + 1
        })).catch(() => {});
      }
      await ctx.telegram.deleteMessage(ctx.chat.id, progress.message_id).catch(async () => {
        await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `✅ Preview sent: ${posts.length} post(s).`).catch(() => {});
      });
    } catch (error) {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `⚠️ Preview stopped after sending some posts: ${error.message}`).catch(() => {});
      throw error;
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
    this.setupTrafficPresets.delete(ctx.from.id);
    this.setupSampleCache.delete(ctx.from.id);
    this.setupCurrentView.delete(ctx.from.id);
    this.setupScheduleWizards.delete(ctx.from.id);
    this.setupTextPrompts.delete(ctx.from.id);
  }

  async cancel(ctx) {
    this.sessions.delete(ctx.from.id);
    this.setupSuggestions.delete(ctx.from.id);
    this.setupMeta.delete(ctx.from.id);
    this.setupLastChange.delete(ctx.from.id);
    this.setupTrafficPresets.delete(ctx.from.id);
    this.setupSampleCache.delete(ctx.from.id);
    this.setupCurrentView.delete(ctx.from.id);
    this.setupScheduleWizards.delete(ctx.from.id);
    this.setupTextPrompts.delete(ctx.from.id);
    await this.clearLastSetupKeyboard(ctx);
    await ctx.reply('Setup mode cancelled.');
  }

  async handleSetupText(ctx) {
    if (!ctx?.from?.id || !this.sessions.has(ctx.from.id)) return;
    const text = ctx.message?.text || '';
    if (text.startsWith('/')) return;
    const prompt = this.setupTextPrompts.get(ctx.from.id);
    if (!prompt) return;

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

  async replaceCurrentSetupMessage(ctx, text, keyboard, extra = {}) {
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

  rememberCurrentView(ctx, view) {
    if (!ctx?.from?.id || !view) return;
    this.setupCurrentView.set(ctx.from.id, view);
  }

  getCurrentView(ctx) {
    return this.setupCurrentView.get(ctx.from.id) || 'suggest';
  }

  reloadConfig() {
    replaceObjectContents(this.config, this.configLoader());
  }
}

export { stringifyForSetup } from './setup/utils.js';




function clampIndex(index = 0, total = 0) {
  if (!total) return 0;
  const parsed = Number(index || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, parsed), total - 1);
}

function normalizeLoadMoreTarget(target, fallback = 'suggest') {
  const allowed = new Set([
    'suggest',
    'filters_options',
    'author_options',
    'reaction_options',
    'filter_impact',
    'author_test',
    'reaction_test',
    'parser_paths',
    'technical',
    'technical_field_scan',
    'technical_shape',
    'technical_reactions',
    'technical_author',
    'sources',
    'manual_schedule',
    'test'
  ]);
  const normalized = String(target || '').trim();
  if (allowed.has(normalized) || normalized.startsWith('technical_trace:') || normalized.startsWith('technical_raw:') || normalized.startsWith('technical_preview')) return normalized;
  const fallbackValue = String(fallback || '').trim();
  if (allowed.has(fallbackValue) || fallbackValue.startsWith('technical_trace:') || fallbackValue.startsWith('technical_raw:') || fallbackValue.startsWith('technical_preview')) return fallbackValue;
  return 'suggest';
}

function normalizeTechnicalTraceMode(mode) {
  const normalized = String(mode || 'matched').trim();
  return ['matched', 'rejected', 'unknown_author', 'zero_likes'].includes(normalized) ? normalized : 'matched';
}

function normalizeTechnicalRawMode(mode) {
  const normalized = String(mode || 'matched').trim();
  return ['matched', 'rejected', 'buttons', 'native_reactions', 'mention'].includes(normalized) ? normalized : 'matched';
}

function formatLoadMoreTarget(target) {
  return String(target || 'suggest').replace(/_/g, ' ');
}

function getCategoryExtraRows(category) {
  if (category === 'filters') return [[button('Filter impact', 'setup:filter_impact'), button('Test content', 'setup:test')]];
  if (category === 'author') return [[button('Test author', 'setup:author_test')]];
  if (category === 'reactions') return [[button('Test reactions', 'setup:reaction_test'), button('Reaction diagnostics', 'setup:technical_reactions')]];
  return [];
}

function formatPreviewProgress({ total, sent, current = null }) {
  const lines = [
    '📤 Sending preview',
    '',
    `The bot will send ${total} preview post(s).`,
    `Sent: ${sent}/${total}.`
  ];
  if (current !== null) lines.push('', `Sending post ${current}/${total}...`);
  return lines.join('\n');
}

function parseCachedSetupPosts(messages, draft, config) {
  return parseMessagesToPosts(messages, {
    chatId: config.telegram?.sourceChatId,
    parsing: draft.parsing || config.parsing || {}
  });
}

function formatSampleProgress({ purpose, scanned, matched, minMatched, maxLimit, exhausted = false, status = 'loading' }) {
  const hasMatchedTarget = Number.isFinite(Number(minMatched));
  const lines = [
    `🔎 Collecting sample · ${purpose}`,
    '',
    `Loaded: ${scanned}/${maxLimit} message(s).`,
    hasMatchedTarget
    ? `Matched parser filters: ${matched}/${minMatched}.`
    : `Matched parser filters: ${matched}.`
  ];
  if (status === 'starting') lines.push('', 'Starting scan...');
  else if (status === 'using-cache') lines.push('', 'Using cached messages first. Loading more only if needed...');
  else if (status === 'done') {
    if (!hasMatchedTarget) lines.push('', exhausted ? 'Done. Source history ended.' : 'Done. Loaded one more sample page.');
    else if (matched >= minMatched) lines.push('', 'Done. Enough matched posts for a reliable sample.');
    else if (exhausted) lines.push('', 'Done. Source history ended before enough matched posts were found.');
    else lines.push('', 'Done. Sample is still small; parser filters may be strict.');
  } else if (!hasMatchedTarget || matched < minMatched) {
    lines.push('', 'Loading more messages...');
  }
  return lines.join('\n');
}
