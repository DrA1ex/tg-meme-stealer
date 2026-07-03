import { validateSetupDraft } from '../../core/setupConfig.js';
import { button, inlineKeyboard } from './keyboards.js';
import {
  countRules,
  findDuplicates,
  findScheduleConflicts,
  formatRelativeSetupTime,
  formatTemplateLines,
  getEffectiveGlobalFirstSendAt,
  isPreviewStale,
  setupScreen
} from './formattingBase.js';

export function formatNoLastChange() {
  return setupScreen({
    icon: 'ℹ️',
    title: 'No last change details',
    sections: [
      ['📌 State', ['No parser or publishing changes were recorded in this setup session yet.']],
      ['➡️ Next', ['Apply a suggestion or preset, then use Show last change.']]
    ]
  });
}

export function formatLastChange(change) {
  return setupScreen({
    icon: '🧾',
    title: 'Last change details',
    sections: [
      ['📌 Summary', [change.title || 'Draft changed', `Area: ${change.area || 'draft'}`]],
      ['# Details', change.detailLines?.length ? change.detailLines : ['No details recorded.']],
      ['➡️ Next', ['Run Doctor or Preview before saving.']]
    ]
  });
}

export function lastChangeKeyboard(area) {
  const back = area === 'publishing' ? 'setup:publish' : 'setup:parser';
  return inlineKeyboard([
    [button('Doctor', 'setup:doctor'), button('Preview', 'setup:preview')],
    [button('Back', back), button('Setup status', 'setup:status')]
  ]);
}

export function formatConfirmResetFilters(filters) {
  return setupScreen({
    icon: '⚠️',
    title: 'Reset parser filters?',
    sections: [
      ['🗑 What will happen', [
        `Current filter rules: ${Array.isArray(filters) ? filters.length : 0}.`,
        'Only parsing.filters will be cleared.',
        'Author, likes, and dislikes rules will stay unchanged.'
      ]],
      ['➡️ Next', ['Confirm reset, then apply filter suggestions again.']]
    ]
  });
}

export function formatSetupStatusLines(draft = {}, baseConfig = {}, meta = createSetupMeta()) {
  const parsing = draft.parsing || {};
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const enabledTemplates = templates.filter((template) => template.enabled !== false);
  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);
  const lines = [
    `Parser: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author rule(s), ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`,
    `Publishing: ${templates.length} template(s), ${enabledTemplates.length} enabled, ${sources.length} source(s).`,
    `dryRun=${Boolean(publish.dryRun)}, timezone=${baseConfig.schedule?.timezone || 'default'}.`
  ];

  if (firstSendAt) lines.push(`First send gate: ${firstSendAt}.`);
  if (isPreviewStale(meta)) lines.push('⚠️ Preview is stale after draft changes.');
  return lines;
}

export function formatSetupIntro(draft, meta = createSetupMeta()) {
  return setupScreen({
    icon: '🧰',
    title: 'Setup mode',
    sections: [
      ['🎛 Flow', [
        'Use buttons for the common path: Status → Doctor → Parser/Publishing → Preview → Save.',
        'Advanced JSON commands still work, but they are a fallback for exact tuning.'
      ]],
      ['📌 Current draft', formatSetupStatusLines(draft, {}, meta)],
      ['➡️ Next', [
        'Run Doctor for obvious issues, or start with Parser → Auto suggestions.'
      ]]
    ]
  });
}

export function formatSetupStatus(draft, baseConfig = {}, meta = createSetupMeta()) {
  return setupScreen({
    icon: '📌',
    title: 'Setup status',
    sections: [
      ['🧩 Parser', formatParserStatusLines(draft.parsing || {}, meta)],
      ['📣 Publishing', formatPublishingStatusLines(draft.publish || {}, baseConfig)],
      ['🧪 Validation', formatValidationStatusLines(draft, meta)],
      ['➡️ Next', [
        isPreviewStale(meta)
          ? 'Preview is stale after changes. Run Preview before Save.'
          : 'Run Doctor or Preview before saving if you changed the draft.',
        'Parser suggestions and Publishing presets are available from their screens.'
      ]]
    ]
  });
}

export function formatParserStatusLines(parsing, meta = createSetupMeta()) {
  const lines = [
    `${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author rule(s), ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`
  ];
  if (meta.changedArea === 'parser') lines.push('⚠️ Parser changed after the last test/preview.');
  return lines;
}

export function formatPublishingStatusLines(publish, baseConfig = {}) {
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const enabledTemplates = templates.filter((template) => template.enabled !== false);
  const disabledTemplates = templates.length - enabledTemplates.length;
  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);
  return [
    `${templates.length} template(s), ${enabledTemplates.length} enabled, ${disabledTemplates} disabled, ${sources.length} source(s).`,
    `dryRun=${Boolean(publish.dryRun)}, timezone=${baseConfig.schedule?.timezone || 'default'}.`,
    firstSendAt ? `First send gate: ${firstSendAt}` : 'First send gate: not set.',
    '',
    'Enabled templates:',
    ...formatTemplateLines(enabledTemplates)
  ];
}

export function formatValidationStatusLines(draft, meta = createSetupMeta()) {
  const lines = [];
  if (meta.changedAt) lines.push(`Last change: ${meta.changedArea || 'draft'} · ${formatRelativeSetupTime(meta.changedAt)}.`);
  lines.push(meta.testedAt ? `Parser test: ${formatRelativeSetupTime(meta.testedAt)}.` : 'Parser test: not run in this setup session.');
  lines.push(meta.previewedAt ? `Preview: ${formatRelativeSetupTime(meta.previewedAt)}.` : 'Preview: not run in this setup session.');
  if (isPreviewStale(meta)) lines.push('⚠️ Preview is stale after draft changes.');
  return lines;
}

export function formatParserMenu(draft) {
  const parsing = draft.parsing || {};
  return setupScreen({
    icon: '🧩',
    title: 'Parser setup',
    sections: [
      ['📌 Current rules', [
        `${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author, ${countRules(parsing.likes)} likes, ${countRules(parsing.dislikes)} dislikes.`
      ]],
      ['✨ Available now', [
        'Auto suggestions scans recent messages and offers buttons for filters, author, and reaction buttons.',
        'Parser paths shows detected text/button fields before you choose rules.',
        'Author test, Reaction test, and Filter impact explain what the current rules actually do.',
        'Advanced JSON is still available for exact rules.'
      ]],
      ['➡️ Next', ['Run Parser paths or Auto suggestions first, then Author/Reaction test and Preview.']]
    ]
  });
}

export function formatPublishMenu(draft, baseConfig = {}) {
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  return setupScreen({
    icon: '📣',
    title: 'Publishing setup',
    sections: [
      ['📌 Current publish config', [
        `Sources: ${sources.length}`,
        `Templates: ${templates.length}`,
        `Timezone: ${baseConfig.schedule?.timezone || 'default'}`
      ]],
      ['🗓 Templates', formatTemplateLines(templates, { includeDisabled: true })],
      ['✨ Available now', [
        'Presets can add/update common schedules with buttons, including time/strictness variants.',
        'Traffic suggestions has recent-scan and extended database modes, and can add schedules with buttons.',
        'Manage templates can enable, disable, or remove schedules from the draft.',
        'Schedule preview shows soon runs plus the next run for every enabled template.',
        'Schedule doctor checks conflicts, firstSendAt shifts, and daily window gaps/overlaps.',
        'Source test checks publish.sources[].where against stored posts.',
        'Advanced JSON still edits exact sources/templates.'
      ]],
      ['➡️ Next', ['Choose Presets or Traffic suggestions, then run Source test and Schedule doctor.', 'Use Manage templates to remove old or duplicate schedules.']]
    ]
  });
}

export function formatSetupDoctor({ draft, baseConfig, preview }) {
  const errors = [];
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
    errors.push(`Config validation failed: ${error.message}`);
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
      errors.push(`Template ${template.key || '<missing key>'} uses unknown source ${template.source}.`);
    }
  }

  for (const duplicate of findDuplicates(templates.map((template) => template.key).filter(Boolean))) {
    errors.push(`Duplicate publish template key: ${duplicate}.`);
  }

  for (const conflict of findScheduleConflicts(templates)) {
    warnings.push(`Schedule conflict: ${conflict}.`);
  }

  const disabled = templates.filter((template) => template.enabled === false);
  if (disabled.length) notes.push(`Disabled templates: ${disabled.map((template) => template.key).join(', ')}.`);

  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);
  if (firstSendAt) notes.push(`First send gate is set to ${firstSendAt}. Runs before this timestamp are skipped unless forced.`);

  if (!templates.length) warnings.push('No publish templates configured.');
  if (!sources.length) warnings.push('No publish sources configured.');

  return setupScreen({
    icon: '🩺',
    title: 'Setup doctor',
    sections: [
      ['❌ Errors', errors.length ? errors.map((item) => `- ${item}`) : ['none']],
      ['⚠️ Warnings', warnings.length ? warnings.map((item) => `- ${item}`) : ['none']],
      ['📝 Notes', notes.length ? notes.map((item) => `- ${item}`) : ['none']],
      ['➡️ Next', ['Use Preview to inspect real output before saving.']]
    ]
  });
}

