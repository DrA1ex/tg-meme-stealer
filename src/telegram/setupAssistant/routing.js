import {
  getMaxTrafficDays,
  setupMenuKeyboard,
  getArgument
} from './deps.js';

const COMMAND_ALIASES = new Map([
  ['suggestions', 'suggest'],
  ['presets', 'publish_presets']
]);

const DIRECT_HANDLERS = {
  status: (assistant, ctx) => assistant.status(ctx),
  doctor: (assistant, ctx) => assistant.doctor(ctx),
  preview: (assistant, ctx) => assistant.previewDefaults(ctx),
  test: (assistant, ctx) => assistant.testDefaults(ctx),
  parser: (assistant, ctx) => assistant.parserMenu(ctx),
  filters: (assistant, ctx) => assistant.filtersMenu(ctx),
  filters_options: (assistant, ctx) => assistant.filterOptions(ctx),
  author: (assistant, ctx) => assistant.authorMenu(ctx),
  author_options: (assistant, ctx) => assistant.authorOptions(ctx),
  reactions: (assistant, ctx) => assistant.reactionsMenu(ctx),
  reaction_options: (assistant, ctx) => assistant.reactionOptions(ctx),
  technical: (assistant, ctx) => assistant.technicalDiagnostics(ctx),
  reset_author: (assistant, ctx) => assistant.resetAuthor(ctx),
  reset_reactions: (assistant, ctx) => assistant.resetReactions(ctx),
  parser_config: (assistant, ctx) => assistant.showParserConfig(ctx),
  suggest: (assistant, ctx) => assistant.suggestParser(ctx),
  parser_paths: (assistant, ctx) => assistant.parserPaths(ctx),
  author_test: (assistant, ctx) => assistant.authorTest(ctx),
  reaction_test: (assistant, ctx) => assistant.reactionTest(ctx),
  filter_impact: (assistant, ctx) => assistant.filterImpact(ctx),
  reset_filters: (assistant, ctx) => assistant.confirmResetFilters(ctx),
  reset_filters_confirm: (assistant, ctx) => assistant.resetFilters(ctx),
  publish: (assistant, ctx) => assistant.publishMenu(ctx),
  publish_presets: (assistant, ctx) => assistant.publishPresets(ctx),
  publish_config: (assistant, ctx) => assistant.showPublishConfig(ctx),
  schedule_preview: (assistant, ctx) => assistant.schedulePreview(ctx),
  schedule_doctor: (assistant, ctx) => assistant.scheduleDoctor(ctx),
  traffic_suggestions: (assistant, ctx) => assistant.trafficSuggestions(ctx),
  traffic_week: (assistant, ctx) => assistant.extendedTrafficSuggestions(ctx, 7),
  traffic_month: (assistant, ctx) => assistant.extendedTrafficSuggestions(ctx, 30),
  traffic_max: (assistant, ctx) => assistant.extendedTrafficSuggestions(ctx, getMaxTrafficDays(assistant.config)),
  manage_templates: (assistant, ctx) => assistant.manageTemplates(ctx),
  sources: (assistant, ctx) => assistant.sourcesMenu(ctx),
  source_custom: (assistant, ctx) => assistant.sourceCustomHelp(ctx),
  source_custom_cancel: async (assistant, ctx) => {
    assistant.setupTextPrompts.delete(ctx.from.id);
    await assistant.sourcesMenu(ctx);
  },
  sources_reset: (assistant, ctx) => assistant.resetSources(ctx),
  manual_schedule: (assistant, ctx) => assistant.startManualSchedule(ctx),
  manual_create: (assistant, ctx) => assistant.createManualSchedule(ctx),
  source_test: (assistant, ctx) => assistant.sourceTest(ctx),
  last_change: (assistant, ctx) => assistant.showLastChange(ctx),
  advanced: (assistant, ctx) => assistant.advanced(ctx),
  config: (assistant, ctx) => assistant.showDraftConfig(ctx)
};

const PREFIX_HANDLERS = [
  ['load_more:', (assistant, ctx, value) => assistant.loadMoreMessages(ctx, value)],
  ['technical_', (assistant, ctx, _value, action) => assistant.technicalAction(ctx, action)],
  ['refresh_sample', (assistant, ctx, _value, action) => assistant.refreshSample(ctx, action.includes(':') ? action.split(':').slice(1).join(':') : 'technical')],
  ['apply:', (assistant, ctx, value) => assistant.applySuggestion(ctx, value)],
  ['noop:', () => {}],
  ['traffic_extended:', (assistant, ctx, value) => assistant.extendedTrafficSuggestions(ctx, Number(value))],
  ['traffic_apply:', (assistant, ctx, value) => assistant.applyTrafficPreset(ctx, value)],
  ['template_enable:', (assistant, ctx, value) => assistant.setTemplateEnabled(ctx, value, true)],
  ['template_disable:', (assistant, ctx, value) => assistant.setTemplateEnabled(ctx, value, false)],
  ['template_remove_confirm:', (assistant, ctx, value) => assistant.removeTemplate(ctx, value)],
  ['template_remove:', (assistant, ctx, value) => assistant.confirmRemoveTemplate(ctx, value)],
  ['source_preset:', (assistant, ctx, value) => assistant.applySourcePresetAction(ctx, value)],
  ['manual_source:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { source: value })],
  ['manual_cadence:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { cadence: value, weekdays: [], dayOfMonth: null, time: '', windowHours: null })],
  ['manual_weekday:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { weekdays: [Number(value)] })],
  ['manual_weekdays:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { weekdays: value.split(',').map(Number) })],
  ['manual_monthday:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { dayOfMonth: Number(value) })],
  ['manual_time:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { time: value })],
  ['manual_window:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { windowHours: Number(value) })],
  ['manual_posts:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { postsPreset: value })],
  ['manual_threshold:', (assistant, ctx, value) => assistant.manualScheduleSet(ctx, { thresholdPreset: value })],
  ['preset:', (assistant, ctx, value) => assistant.showPublishPreset(ctx, value)],
  ['apply_preset:', (assistant, ctx, value) => assistant.applyPublishPreset(ctx, value, { replace: false })],
  ['replace_preset_confirm:', (assistant, ctx, value) => assistant.applyPublishPreset(ctx, value, { replace: true })],
  ['replace_preset:', (assistant, ctx, value) => assistant.confirmReplacePublishPreset(ctx, value)]
];

export async function setupCommand(ctx) {
  const rawAction = getArgument(ctx.message.text).toLowerCase();
  const action = COMMAND_ALIASES.get(rawAction) || rawAction;
  if (!action) {
    await this.start(ctx);
    return;
  }

  if (action === 'cancel') {
    await this.cancel(ctx);
    return;
  }

  if (action === 'save') {
    await this.withSession(ctx, () => this.done(ctx));
    return;
  }

  const handler = getSetupActionHandler(action);
  if (!handler) {
    await this.replyWithKeyboard(
      ctx,
      `Unknown setup action: ${action}\n\nUse /setup or choose a button from the setup menu.`,
      setupMenuKeyboard()
    );
    return;
  }

  this.ensureSession(ctx);
  await handler(this, ctx, action);
}

export async function setupAction(ctx) {
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
    const handler = getSetupActionHandler(action);
    if (!handler) {
      await this.replyWithKeyboard(ctx, `Unknown setup button: ${action}`, setupMenuKeyboard());
      return;
    }
    await handler(this, ctx, action);
  } catch (error) {
    await this.replyWithKeyboard(ctx, `Setup error: ${error.message}`, setupMenuKeyboard());
  }
}

function getSetupActionHandler(action) {
  if (DIRECT_HANDLERS[action]) return DIRECT_HANDLERS[action];
  for (const [prefix, handler] of PREFIX_HANDLERS) {
    if (action.startsWith(prefix)) {
      return (assistant, ctx) => handler(assistant, ctx, action.slice(prefix.length), action);
    }
  }
  return null;
}

export const routingMethods = {
  setupCommand,
  setupAction
};
