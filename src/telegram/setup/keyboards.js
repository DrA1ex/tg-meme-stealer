import { PUBLISH_PRESETS } from './publishPresets.js';

export function setupMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Doctor', 'setup:doctor')],
    [button('Preview', 'setup:preview'), button('Test parser', 'setup:test')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Show last change', 'setup:last_change'), button('Show config', 'setup:config')],
    [button('Advanced JSON', 'setup:advanced')],
    [button('Save', 'setup:save'), button('Cancel', 'setup:cancel')]
  ]);
}

export function parserMenuKeyboard() {
  return inlineKeyboard([
    [button('Auto suggestions', 'setup:suggest'), button('Filter impact', 'setup:filter_impact')],
    [button('Parser paths', 'setup:parser_paths')],
    [button('Author test', 'setup:author_test'), button('Reaction test', 'setup:reaction_test')],
    [button('Reset filters', 'setup:reset_filters')],
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Show parser config', 'setup:parser_config')],
    [button('Advanced JSON', 'setup:advanced'), button('Status', 'setup:status')],
    [button('Back to setup', 'setup:status')]
  ]);
}

export function parserAfterApplyKeyboard() {
  return inlineKeyboard([
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Show parser config', 'setup:parser_config')],
    [button('More suggestions', 'setup:suggest'), button('Back', 'setup:parser')]
  ]);
}

export function publishMenuKeyboard() {
  return inlineKeyboard([
    [button('Presets', 'setup:publish_presets'), button('Traffic suggestions', 'setup:traffic_suggestions')],
    [button('Manage templates', 'setup:manage_templates')],
    [button('Schedule preview', 'setup:schedule_preview'), button('Schedule doctor', 'setup:schedule_doctor')],
    [button('Source test', 'setup:source_test'), button('Show publish config', 'setup:publish_config')],
    [button('Doctor', 'setup:doctor'), button('Preview', 'setup:preview')],
    [button('Advanced JSON', 'setup:advanced'), button('Show full config', 'setup:config')],
    [button('Back to setup', 'setup:status')]
  ]);
}

export function publishPresetsKeyboard() {
  const rows = PUBLISH_PRESETS.map((preset) => [button(preset.title, `setup:preset:${preset.id}`)]);
  rows.push([button('Show publish config', 'setup:publish_config')]);
  rows.push([button('Back', 'setup:publish')]);
  return inlineKeyboard(rows);
}

export function publishPresetDetailsKeyboard(preset) {
  return inlineKeyboard([
    [button('Apply / update preset', `setup:apply_preset:${preset.id}`)],
    [button('Replace all templates with preset', `setup:replace_preset:${preset.id}`)],
    [button('Show publish config', 'setup:publish_config')],
    [button('Back to presets', 'setup:publish_presets'), button('Publishing', 'setup:publish')]
  ]);
}

export function confirmReplacePublishPresetKeyboard(preset) {
  return inlineKeyboard([
    [button('Yes, replace templates', `setup:replace_preset_confirm:${preset.id}`)],
    [button('Back to preset', `setup:preset:${preset.id}`), button('Presets', 'setup:publish_presets')]
  ]);
}

export function publishAfterPresetKeyboard() {
  return inlineKeyboard([
    [button('Show last change', 'setup:last_change'), button('Show publish config', 'setup:publish_config')],
    [button('Schedule preview', 'setup:schedule_preview'), button('Manage templates', 'setup:manage_templates')],
    [button('Presets', 'setup:publish_presets')],
    [button('Doctor', 'setup:doctor'), button('Preview', 'setup:preview')],
    [button('Save', 'setup:save'), button('Publishing', 'setup:publish')]
  ]);
}

export function manageTemplatesKeyboard(templates = []) {
  const rows = [];
  for (const template of templates.slice(0, 18)) {
    const key = template.key;
    if (!key) continue;
    const toggle = template.enabled === false
      ? button(`Enable ${shortKey(key)}`, `setup:template_enable:${key}`)
      : button(`Disable ${shortKey(key)}`, `setup:template_disable:${key}`);
    rows.push([toggle, button(`Remove ${shortKey(key)}`, `setup:template_remove:${key}`)]);
  }
  rows.push([button('Show publish config', 'setup:publish_config')]);
  rows.push([button('Back', 'setup:publish')]);
  return inlineKeyboard(rows);
}

function shortKey(key) {
  const text = String(key);
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

export function confirmRemoveTemplateKeyboard(key) {
  return inlineKeyboard([
    [button('Yes, remove template', `setup:template_remove_confirm:${key}`)],
    [button('Back to templates', 'setup:manage_templates'), button('Publishing', 'setup:publish')]
  ]);
}

export function trafficSuggestionsKeyboard(presets = [], options = {}) {
  const rows = [];
  for (const preset of presets.slice(0, 4)) {
    rows.push([button(preset.title, `setup:traffic_apply:${preset.id}`)]);
  }
  rows.push([button('Recent scan', 'setup:traffic_suggestions')]);
  rows.push([button('Extended · week', 'setup:traffic_extended:7'), button('Extended · month', 'setup:traffic_extended:30')]);
  if (options.maxDays && options.maxDays > 30) rows.push([button(`Extended · max ${options.maxDays}d`, `setup:traffic_extended:${options.maxDays}`)]);
  rows.push([button('Schedule preview', 'setup:schedule_preview'), button('Publishing', 'setup:publish')]);
  return inlineKeyboard(rows);
}

export function previewMenuKeyboard() {
  return inlineKeyboard([
    [button('Looks good / Save', 'setup:save'), button('Run doctor', 'setup:doctor')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Back to setup', 'setup:status')]
  ]);
}

export function advancedMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Show config', 'setup:config')],
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Back to setup', 'setup:status')]
  ]);
}

export function mergeReplyOptions(extra, keyboard) {
  return {
    ...(extra || {}),
    ...(keyboard || {}),
    reply_markup: {
      ...(extra?.reply_markup || {}),
      ...(keyboard?.reply_markup || {})
    }
  };
}

export function inlineKeyboard(inlineKeyboardRows) {
  return { reply_markup: { inline_keyboard: inlineKeyboardRows } };
}

export function button(text, callbackData) {
  return { text, callback_data: callbackData };
}
