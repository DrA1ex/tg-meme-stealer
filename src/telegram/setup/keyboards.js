import { PUBLISH_PRESETS } from './publishPresets.js';
import { SOURCE_PRESETS } from './sourcePresets.js';
import { POSTS_PRESETS, THRESHOLD_PRESETS, TIME_OPTIONS, WEEKDAYS, WINDOW_OPTIONS, getPublishSources } from './scheduleWizard.js';

export function setupMenuKeyboard() {
  return inlineKeyboard([
    [button('Content setup', 'setup:parser'), button('Publishing setup', 'setup:publish')],
    [button('Diagnostics', 'setup:technical'), button('Check & save', 'setup:check')],
    [button('Advanced', 'setup:advanced')],
    [button('Save', 'setup:save'), button('Cancel', 'setup:cancel')]
  ]);
}

export function checkAndSaveKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Doctor', 'setup:doctor')],
    [button('Test content', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Show last change', 'setup:last_change')],
    [button('Save', 'setup:save'), button('Cancel', 'setup:cancel')],
    [button('Home', 'setup:home')]
  ]);
}

export function parserMenuKeyboard() {
  return inlineKeyboard([
    [button('Quick setup', 'setup:suggest')],
    [button('Filters', 'setup:filters'), button('Author', 'setup:author')],
    [button('Reactions', 'setup:reactions')],
    [button('Test content', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Pending Content Config', 'setup:parser_config'), button('Saved Content Config', 'setup:saved_parser_config')],
    [button('Home', 'setup:home')]
  ]);
}

export function filtersMenuKeyboard() {
  return inlineKeyboard([
    [button('Filter options', 'setup:filters_options'), button('Filter impact', 'setup:filter_impact')],
    [button('Pending Config', 'setup:filters_pending_config')],
    [button('Test content', 'setup:test'), button('Reset filters', 'setup:reset_filters')],
    [button('Content setup', 'setup:parser'), button('Home', 'setup:home')]
  ]);
}

export function authorMenuKeyboard() {
  return inlineKeyboard([
    [button('Author options', 'setup:author_options'), button('Test author', 'setup:author_test')],
    [button('Pending Config', 'setup:author_pending_config')],
    [button('Reset author', 'setup:reset_author')],
    [button('Content setup', 'setup:parser'), button('Home', 'setup:home')]
  ]);
}

export function reactionsMenuKeyboard() {
  return inlineKeyboard([
    [button('Reaction options', 'setup:reaction_options'), button('Test reactions', 'setup:reaction_test')],
    [button('Pending Config', 'setup:reactions_pending_config')],
    [button('Reaction diagnostics', 'setup:technical_reactions'), button('Reset reactions', 'setup:reset_reactions')],
    [button('Content setup', 'setup:parser'), button('Home', 'setup:home')]
  ]);
}

export function technicalDiagnosticsKeyboard() {
  return inlineKeyboard([
    [button('Why matched?', 'setup:technical_trace:matched'), button('Why rejected?', 'setup:technical_trace:rejected')],
    [button('Unknown author?', 'setup:technical_trace:unknown_author'), button('Zero likes?', 'setup:technical_trace:zero_likes')],
    [button('Message browser', 'setup:technical_preview:0')],
    [button('Reaction fields', 'setup:technical_reactions'), button('Author fields', 'setup:technical_author')],
    [button('Raw / advanced tools', 'setup:technical_raw_tools')],
    [button('Load more messages', 'setup:load_more:technical'), button('Refresh sample', 'setup:refresh_sample:technical')],
    [button('Content setup', 'setup:parser'), button('Home', 'setup:home')]
  ]);
}

export function technicalRawToolsKeyboard() {
  return inlineKeyboard([
    [button('Field scan', 'setup:technical_field_scan'), button('Message shape', 'setup:technical_shape')],
    [button('Raw matched', 'setup:technical_raw:matched'), button('Raw reactions', 'setup:technical_raw:buttons')],
    [button('Pending Content Config', 'setup:parser_config'), button('Advanced JSON', 'setup:advanced')],
    [button('Diagnostics', 'setup:technical'), button('Home', 'setup:home')]
  ]);
}

export function technicalDiagnosticsBackKeyboard(target = 'technical') {
  return inlineKeyboard([
    [button('Load more messages', `setup:load_more:${target}`), button('Refresh sample', `setup:refresh_sample:${target}`)],
    [button('Diagnostics', 'setup:technical'), button('Content setup', 'setup:parser')],
    [button('Home', 'setup:home')]
  ]);
}

export function technicalTraceKeyboard({ mode = 'matched', index = 0, total = 0 } = {}) {
  const rows = [];
  const nav = [];
  if (Number(index || 0) > 0) nav.push(button('Prev', `setup:technical_trace:${mode}:${Number(index || 0) - 1}`));
  if (Number(index || 0) < Number(total || 0) - 1) nav.push(button('Next', `setup:technical_trace:${mode}:${Number(index || 0) + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('Load more messages', `setup:load_more:technical_trace:${mode}:${index}`), button('Refresh sample', `setup:refresh_sample:technical_trace:${mode}:${index}`)]);
  rows.push([button('Diagnostics', 'setup:technical'), button('Message browser', 'setup:technical_preview:0')]);
  rows.push([button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

export function technicalRawKeyboard({ mode = 'matched', index = 0, total = 0 } = {}) {
  const rows = [];
  const nav = [];
  if (Number(index || 0) > 0) nav.push(button('Prev', `setup:technical_raw:${mode}:${Number(index || 0) - 1}`));
  if (Number(index || 0) < Number(total || 0) - 1) nav.push(button('Next', `setup:technical_raw:${mode}:${Number(index || 0) + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('Load more messages', `setup:load_more:technical_raw:${mode}:${index}`), button('Refresh sample', `setup:refresh_sample:technical_raw:${mode}:${index}`)]);
  rows.push([button('Diagnostics', 'setup:technical'), button('Message browser', 'setup:technical_preview:0')]);
  rows.push([button('Raw tools', 'setup:technical_raw_tools'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

export function parserAfterApplyKeyboard() {
  return inlineKeyboard([
    [button('Test content', 'setup:test'), button('Preview', 'setup:preview')],
    [button('More suggestions', 'setup:suggest'), button('Content setup', 'setup:parser')],
    [button('Check & save', 'setup:check')]
  ]);
}


export function manualParserApplyKeyboard(category = 'parser') {
  const pendingAction = category === 'author'
    ? 'setup:author_pending_config'
    : category === 'reactions'
      ? 'setup:reactions_pending_config'
      : category === 'filters'
        ? 'setup:filters_pending_config'
        : 'setup:parser_config';
  const optionAction = category === 'author'
    ? 'setup:author_options'
    : category === 'reactions'
      ? 'setup:reaction_options'
      : category === 'filters'
        ? 'setup:filters_options'
        : 'setup:suggest';
  return inlineKeyboard([
    [button('Content setup', 'setup:parser'), button('Pending Config', pendingAction)],
    [button('More options', optionAction)],
    [button('Test content', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Check & save', 'setup:check'), button('Home', 'setup:home')]
  ]);
}

export function publishMenuKeyboard() {
  return inlineKeyboard([
    [button('Recommended presets', 'setup:publish_presets'), button('Traffic suggestions', 'setup:traffic_suggestions')],
    [button('Manual schedule', 'setup:manual_schedule')],
    [button('Sources', 'setup:sources'), button('Schedules', 'setup:manage_templates')],
    [button('Schedule preview', 'setup:schedule_preview'), button('Schedule doctor', 'setup:schedule_doctor')],
    [button('Source test', 'setup:source_test')],
    [button('Publish config', 'setup:publish_config')],
    [button('Home', 'setup:home')]
  ]);
}

export function publishPresetsKeyboard() {
  const rows = PUBLISH_PRESETS.map((preset) => [button(preset.title, `setup:preset:${preset.id}`)]);
  rows.push([button('Publish config', 'setup:publish_config')]);
  rows.push([button('Back', 'setup:publish'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

export function publishPresetDetailsKeyboard(preset) {
  return inlineKeyboard([
    [button('Apply / update preset', `setup:apply_preset:${preset.id}`)],
    [button('Replace all templates with preset', `setup:replace_preset:${preset.id}`)],
    [button('Publish config', 'setup:publish_config')],
    [button('Back to presets', 'setup:publish_presets'), button('Publishing', 'setup:publish')],
    [button('Home', 'setup:home')]
  ]);
}

export function confirmReplacePublishPresetKeyboard(preset) {
  return inlineKeyboard([
    [button('Yes, replace templates', `setup:replace_preset_confirm:${preset.id}`)],
    [button('Back to preset', `setup:preset:${preset.id}`), button('Presets', 'setup:publish_presets')],
    [button('Home', 'setup:home')]
  ]);
}

export function publishAfterPresetKeyboard() {
  return inlineKeyboard([
    [button('Schedule preview', 'setup:schedule_preview'), button('Schedule doctor', 'setup:schedule_doctor')],
    [button('Show last change', 'setup:last_change'), button('Schedules', 'setup:manage_templates')],
    [button('Presets', 'setup:publish_presets'), button('Publishing', 'setup:publish')],
    [button('Save', 'setup:save'), button('Home', 'setup:home')]
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
  rows.push([button('Publish config', 'setup:publish_config')]);
  rows.push([button('Back', 'setup:publish'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

function shortKey(key) {
  const text = String(key);
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

export function confirmRemoveTemplateKeyboard(key) {
  return inlineKeyboard([
    [button('Yes, remove template', `setup:template_remove_confirm:${key}`)],
    [button('Back to schedules', 'setup:manage_templates'), button('Publishing', 'setup:publish')],
    [button('Home', 'setup:home')]
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
  rows.push([button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}


export function sourcesKeyboard(draft = {}) {
  const selected = new Set((Array.isArray(draft?.publish?.sources) ? draft.publish.sources : []).map((source) => source.key));
  const rows = SOURCE_PRESETS.map((preset) => [button(`${selected.has(preset.key) ? '✓' : '•'} ${preset.title}`, `setup:source_preset:${preset.id}`)]);
  rows.push([button('Add custom source', 'setup:source_custom'), button('Reset sources', 'setup:sources_reset')]);
  rows.push([button('Source test', 'setup:source_test'), button('Publish config', 'setup:publish_config')]);
  rows.push([button('Publishing', 'setup:publish'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}


export function sourceCustomInputKeyboard() {
  return inlineKeyboard([
    [button('Back to sources', 'setup:source_custom_cancel')],
    [button('Sources', 'setup:sources'), button('Publishing', 'setup:publish')],
    [button('Home', 'setup:home')]
  ]);
}

export function manualScheduleKeyboard({ draft = {}, baseConfig = {}, wizard = {}, step = 'source' } = {}) {
  const rows = [];
  if (step === 'source') {
    for (const source of getPublishSources(draft, baseConfig).slice(0, 12)) {
      const selected = wizard.source === source.key;
      rows.push([button(`${selected ? '✓ ' : '• '}${source.key}`, `setup:manual_source:${source.key}`)]);
    }
    rows.push([button('Add source preset', 'setup:sources')]);
  } else if (step === 'cadence') {
    rows.push([button('Daily', 'setup:manual_cadence:daily'), button('Weekly', 'setup:manual_cadence:weekly')]);
    rows.push([button('Twice weekly', 'setup:manual_cadence:twice_weekly'), button('Monthly', 'setup:manual_cadence:monthly')]);
  } else if (step === 'weekday') {
    if (wizard.cadence === 'monthly') {
      rows.push([button('Day 1', 'setup:manual_monthday:1'), button('Day 7', 'setup:manual_monthday:7')]);
      rows.push([button('Day 15', 'setup:manual_monthday:15'), button('Day 28', 'setup:manual_monthday:28')]);
    } else if (wizard.cadence === 'twice_weekly') {
      rows.push([button('Mon + Thu', 'setup:manual_weekdays:1,4'), button('Tue + Fri', 'setup:manual_weekdays:2,5')]);
      rows.push([button('Wed + Sat', 'setup:manual_weekdays:3,6')]);
    } else {
      for (let index = 0; index < WEEKDAYS.length; index += 2) {
        rows.push(WEEKDAYS.slice(index, index + 2).map(([value, label]) => button(label, `setup:manual_weekday:${value}`)));
      }
    }
  } else if (step === 'time') {
    for (let index = 0; index < TIME_OPTIONS.length; index += 3) {
      rows.push(TIME_OPTIONS.slice(index, index + 3).map((time) => button(`${wizard.time === time ? '✓ ' : ''}${time}`, `setup:manual_time:${time}`)));
    }
  } else if (step === 'window') {
    for (let index = 0; index < WINDOW_OPTIONS.length; index += 2) {
      rows.push(WINDOW_OPTIONS.slice(index, index + 2).map((option) => {
        const hours = typeof option === 'object' ? option.hours : option;
        const label = typeof option === 'object' ? option.label : `${option}h`;
        return button(`${Number(wizard.windowHours) === Number(hours) ? '✓ ' : ''}${label}`, `setup:manual_window:${hours}`);
      }));
    }
  } else if (step === 'posts') {
    const entries = Object.entries(POSTS_PRESETS);
    for (let index = 0; index < entries.length; index += 1) rows.push([button(entries[index][1].label, `setup:manual_posts:${entries[index][0]}`)]);
  } else if (step === 'threshold') {
    const entries = Object.entries(THRESHOLD_PRESETS);
    for (let index = 0; index < entries.length; index += 1) rows.push([button(entries[index][1].label, `setup:manual_threshold:${entries[index][0]}`)]);
  } else {
    rows.push([button('Create schedule', 'setup:manual_create')]);
  }
  rows.push([button('Start over', 'setup:manual_schedule'), button('Publishing', 'setup:publish')]);
  rows.push([button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}


export function technicalMessageBrowserKeyboard(messages = [], { page = 0, pageSize = 6 } = {}) {
  const totalPages = Math.max(1, Math.ceil(messages.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page || 0)), totalPages - 1);
  const pageMessages = messages.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const rows = [];
  for (let index = 0; index < pageMessages.length; index += 3) {
    rows.push(pageMessages.slice(index, index + 3).map((message) => {
      const id = Number(message?.id || 0);
      return button(`#${id || '?'}`, `setup:technical_preview_msg:${id}:${currentPage}`);
    }));
  }
  const nav = [];
  if (currentPage > 0) nav.push(button('Prev', `setup:technical_preview:${currentPage - 1}`));
  if (currentPage < totalPages - 1) nav.push(button('Next', `setup:technical_preview:${currentPage + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('View by message ID', `setup:technical_preview_by_id:${currentPage}`)]);
  rows.push([button('Load more messages', `setup:load_more:technical_preview:${currentPage}`), button('Refresh sample', `setup:refresh_sample:technical_preview:${currentPage}`)]);
  rows.push([button('Diagnostics', 'setup:technical'), button('Content setup', 'setup:parser')]);
  rows.push([button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}


export function technicalMessageViewKeyboard({ page = 0, messageId = 0, canPreview = false } = {}) {
  const id = Number(messageId || 0);
  const safePage = Math.max(0, Number(page || 0));
  const rows = [];
  if (id) {
    rows.push([
      button('Overview', `setup:technical_msg:${id}:${safePage}:overview`),
      button('Raw reactions', `setup:technical_msg:${id}:${safePage}:raw_reactions`),
      button('Message shape', `setup:technical_msg:${id}:${safePage}:shape`)
    ]);
    if (canPreview) rows.push([button('Parsed preview', `setup:technical_send_preview:${id}:${safePage}`)]);
  }
  rows.push([button('Back to Message Browser', `setup:technical_preview:${safePage}`)]);
  rows.push([button('Diagnostics', 'setup:technical'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

export function technicalMessagePreviewKeyboard(page = 0, messageId = 0, canPreview = false) {
  const rows = [];
  if (canPreview && messageId) rows.push([button('Preview this post', `setup:technical_send_preview:${messageId}:${page}`)]);
  rows.push([button('Back to message browser', `setup:technical_preview:${page}`)]);
  rows.push([button('Diagnostics', 'setup:technical'), button('Home', 'setup:home')]);
  return inlineKeyboard(rows);
}

export function previewMenuKeyboard() {
  return inlineKeyboard([
    [button('Looks good / Save', 'setup:save'), button('Run doctor', 'setup:doctor')],
    [button('Content setup', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Home', 'setup:home')]
  ]);
}

export function advancedMenuKeyboard() {
  return inlineKeyboard([
    [button('Show full pending config', 'setup:config')],
    [button('Pending Content Config', 'setup:parser_config'), button('Saved Content Config', 'setup:saved_parser_config')],
    [button('Publish config', 'setup:publish_config')],
    [button('Status', 'setup:status'), button('Doctor', 'setup:doctor')],
    [button('Preview', 'setup:preview')],
    [button('Home', 'setup:home')]
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
