import {
  formatDraftConfig,
  validateSetupDraft,
  ADVANCED_HELP,
  DEFAULT_PREVIEW_MESSAGES,
  DEFAULT_SAMPLE_MAX_MESSAGES,
  DEFAULT_SAMPLE_MIN_MATCHED,
  DEFAULT_SAMPLE_STEP_MESSAGES,
  formatPublishMenu,
  buildDatabaseTrafficScheduleSuggestions,
  buildRecentTrafficScheduleSuggestions,
  formatScheduleDoctor,
  formatSchedulePreview,
  formatTrafficScheduleSuggestions,
  getMaxTrafficDays,
  applyPublishPresetToDraft,
  formatAppliedPublishPreset,
  formatConfirmReplacePublishPreset,
  formatPublishChanges,
  formatPublishPresetDetails,
  formatPublishPresetsMenu,
  getPublishPreset,
  findPublishTemplate,
  formatConfirmRemovePublishTemplate,
  formatManagePublishTemplates,
  formatPublishTemplateChanged,
  getPublishTemplates,
  removePublishTemplate,
  setPublishTemplateEnabled,
  formatSourceExpressionTest,
  applySourcePreset,
  formatAppliedSourcePreset,
  formatCustomSourceHelp,
  formatResetSources,
  formatSourcesMenu,
  getSourcePreset,
  resetDraftSources,
  applyManualSchedule,
  createScheduleWizard,
  formatManualScheduleApplied,
  formatManualScheduleConfirm,
  formatManualScheduleWizard,
  getWizardNextStep,
  normalizeWizardStep,
  advancedMenuKeyboard,
  confirmReplacePublishPresetKeyboard,
  confirmRemoveTemplateKeyboard,
  manageTemplatesKeyboard,
  parserMenuKeyboard,
  publishAfterPresetKeyboard,
  publishMenuKeyboard,
  sourcesKeyboard,
  sourceCustomInputKeyboard,
  manualScheduleKeyboard,
  publishPresetDetailsKeyboard,
  publishPresetsKeyboard,
  setupMenuKeyboard,
  trafficSuggestionsKeyboard,
  replyJsonCode
} from './deps.js';

export async function publishMenu(ctx) {
  this.rememberCurrentView(ctx, 'publish');
  await this.replyWithKeyboard(ctx, formatPublishMenu(this.getDraft(ctx), this.config), publishMenuKeyboard());
}

export async function publishPresets(ctx) {
  await this.replyWithKeyboard(ctx, formatPublishPresetsMenu(this.getDraft(ctx)), publishPresetsKeyboard());
}

export async function showPublishPreset(ctx, presetId) {
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

export async function applyPublishPreset(ctx, presetId, { replace = false } = {}) {
  const preset = getPublishPreset(presetId);
  if (!preset) {
    await this.replyWithKeyboard(ctx, 'Unknown publish preset. Choose one from the presets list.', publishPresetsKeyboard());
    return;
  }

  await this.applyPublishPresetObject(ctx, preset, { replace, validationKeyboard: publishPresetDetailsKeyboard(preset) });
}

export async function applyPublishPresetObject(ctx, preset, { replace = false, validationKeyboard = publishMenuKeyboard() } = {}) {
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

export async function confirmReplacePublishPreset(ctx, presetId) {
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

export async function showPublishConfig(ctx) {
  await ctx.reply('Current publishing config:');
  await replyJsonCode(ctx, this.getDraft(ctx).publish || {});
  await this.replyWithKeyboard(ctx, 'Use presets for common schedules, or Advanced JSON for exact tuning.', publishMenuKeyboard());
}

export async function advanced(ctx) {
  await this.replyWithKeyboard(ctx, ADVANCED_HELP, advancedMenuKeyboard());
}

export async function showDraftConfig(ctx) {
  await ctx.reply('Current setup draft:');
  await replyJsonCode(ctx, JSON.parse(formatDraftConfig(this.getDraft(ctx))));
  await this.replyWithKeyboard(ctx, 'Use the buttons to continue setup.', setupMenuKeyboard());
}

export async function showParserConfig(ctx) {
  await ctx.reply('Current parser rules:');
  await replyJsonCode(ctx, this.getDraft(ctx).parsing || {});
  await this.replyWithKeyboard(ctx, 'Use Test content or Preview to check these rules against real source posts.', parserMenuKeyboard());
}

export async function schedulePreview(ctx) {
  await this.replyWithKeyboard(ctx, formatSchedulePreview(this.getDraft(ctx), this.config), publishMenuKeyboard());
}

export async function scheduleDoctor(ctx) {
  await this.replyWithKeyboard(ctx, formatScheduleDoctor(this.getDraft(ctx), this.config), publishMenuKeyboard());
}

export async function trafficSuggestions(ctx) {
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

export async function extendedTrafficSuggestions(ctx, days) {
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

export async function applyTrafficPreset(ctx, presetId) {
  const presets = this.setupTrafficPresets.get(ctx.from.id) || [];
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) {
    await this.replyWithKeyboard(ctx, 'Traffic preset is no longer available. Run Traffic suggestions again.', trafficSuggestionsKeyboard([], { maxDays: getMaxTrafficDays(this.config) }));
    return;
  }

  await this.applyPublishPresetObject(ctx, preset, { replace: false });
}

export async function manageTemplates(ctx) {
  const draft = this.getDraft(ctx);
  await this.replyWithKeyboard(ctx, formatManagePublishTemplates(draft), manageTemplatesKeyboard(getPublishTemplates(draft)));
}

export async function setTemplateEnabled(ctx, key, enabled) {
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

export async function confirmRemoveTemplate(ctx, key) {
  await this.replyWithKeyboard(
    ctx,
    formatConfirmRemovePublishTemplate(this.getDraft(ctx), key),
    confirmRemoveTemplateKeyboard(key)
  );
}

export async function removeTemplate(ctx, key) {
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

export async function sourceTest(ctx) {
  await this.replyWithKeyboard(ctx, await formatSourceExpressionTest({
    repository: this.scanner.repository,
    draft: this.getDraft(ctx),
    baseConfig: this.config
  }), publishMenuKeyboard());
}

export async function sourcesMenu(ctx) {
  this.rememberCurrentView(ctx, 'sources');
  await this.replyWithKeyboard(ctx, formatSourcesMenu(this.getDraft(ctx), this.config), sourcesKeyboard(this.getDraft(ctx)));
}

export async function applySourcePresetAction(ctx, presetId) {
  const preset = getSourcePreset(presetId);
  if (!preset) {
    await this.replyWithKeyboard(ctx, 'Unknown source preset. Choose one from Sources.', sourcesKeyboard(this.getDraft(ctx)));
    return;
  }
  const change = applySourcePreset(this.getDraft(ctx), preset);
  this.markChanged(ctx, 'publishing', `${change.action === 'removed' ? 'Removed' : 'Selected'} source preset: ${preset.key}`, change.lines);
  await this.replyWithKeyboard(ctx, formatAppliedSourcePreset(preset, change), sourcesKeyboard(this.getDraft(ctx)));
}

export async function sourceCustomHelp(ctx, error = '') {
  this.setupTextPrompts.set(ctx.from.id, { kind: 'source_custom' });
  await this.replyWithKeyboard(ctx, formatCustomSourceHelp(error), sourceCustomInputKeyboard());
}

export async function resetSources(ctx) {
  const change = resetDraftSources(this.getDraft(ctx));
  this.markChanged(ctx, 'publishing', 'Reset draft publish sources', change.lines);
  await this.replyWithKeyboard(ctx, formatResetSources(change), sourcesKeyboard(this.getDraft(ctx)));
}

export async function startManualSchedule(ctx) {
  const wizard = createScheduleWizard(this.getDraft(ctx), this.config);
  this.setupScheduleWizards.set(ctx.from.id, wizard);
  await this.showManualScheduleStep(ctx, 'source');
}

export async function manualScheduleSet(ctx, patch = {}) {
  const wizard = this.getManualScheduleWizard(ctx);
  if (Object.prototype.hasOwnProperty.call(patch, 'source') && wizard.source === patch.source) {
    wizard.source = '';
  } else {
    Object.assign(wizard, patch);
  }
  this.setupScheduleWizards.set(ctx.from.id, wizard);
  await this.showManualScheduleStep(ctx, getWizardNextStep(wizard));
}

export async function showManualScheduleStep(ctx, step = '') {
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

export async function createManualSchedule(ctx) {
  const wizard = this.getManualScheduleWizard(ctx);
  const change = applyManualSchedule(this.getDraft(ctx), wizard);
  this.markChanged(ctx, 'publishing', 'Created custom schedule', change.lines);
  this.setupScheduleWizards.delete(ctx.from.id);
  await this.replyWithKeyboard(ctx, formatManualScheduleApplied(change), publishAfterPresetKeyboard());
}

export function getManualScheduleWizard(ctx) {
  if (!this.setupScheduleWizards.has(ctx.from.id)) {
    this.setupScheduleWizards.set(ctx.from.id, createScheduleWizard(this.getDraft(ctx), this.config));
  }
  return this.setupScheduleWizards.get(ctx.from.id);
}

export const publishFlowMethods = {
  publishMenu,
  publishPresets,
  showPublishPreset,
  applyPublishPreset,
  applyPublishPresetObject,
  confirmReplacePublishPreset,
  showPublishConfig,
  advanced,
  showDraftConfig,
  showParserConfig,
  schedulePreview,
  scheduleDoctor,
  trafficSuggestions,
  extendedTrafficSuggestions,
  applyTrafficPreset,
  manageTemplates,
  setTemplateEnabled,
  confirmRemoveTemplate,
  removeTemplate,
  sourceTest,
  sourcesMenu,
  applySourcePresetAction,
  sourceCustomHelp,
  resetSources,
  startManualSchedule,
  manualScheduleSet,
  showManualScheduleStep,
  createManualSchedule,
  getManualScheduleWizard
};
