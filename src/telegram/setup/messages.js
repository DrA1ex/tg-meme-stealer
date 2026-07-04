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
      ['📌 State', ['No content or publishing changes were recorded in this setup session yet.']],
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
    [button('Back', back), button('Check & save', 'setup:check')],
    [button('Home', 'setup:home')]
  ]);
}

export function formatConfirmResetFilters(filters) {
  return setupScreen({
    icon: '⚠️',
    title: 'Reset content filters?',
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
    `Content: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author rule(s), ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`,
    `Publishing: ${templates.length} template(s), ${enabledTemplates.length} enabled, ${sources.length} source(s).`,
    `dryRun=${Boolean(publish.dryRun)}, timezone=${baseConfig.schedule?.timezone || 'default'}.`
  ];

  if (firstSendAt) lines.push(`First send gate: ${firstSendAt}.`);
  if (isPreviewStale(meta)) lines.push('⚠️ Preview is stale after draft changes.');
  return lines;
}

export function formatSetupIntro(draft, baseConfig = {}, meta = createSetupMeta()) {
  return setupScreen({
    icon: '🧰',
    title: 'Setup home',
    sections: [
      ['📌 Draft summary', formatSetupStatusLines(draft, baseConfig, meta)],
      ['1. Content setup', [
        'Use Quick setup first, or tune Filters / Author / Reactions manually.',
        'Content controls which Telegram messages become posts and how author/reactions are extracted.'
      ]],
      ['2. Publishing setup', [
        'Create schedules with presets, traffic suggestions, or the manual wizard.',
        'Manage sources and schedules from the publishing screen.'
      ]],
      ['3. Check & save', [
        'Run Status, Doctor, Test content, and Preview before saving.',
        isPreviewStale(meta) ? 'Preview is stale after draft changes.' : 'No stale preview warning right now.'
      ]]
    ]
  });
}

export function formatSetupStatus(draft, baseConfig = {}, meta = createSetupMeta()) {
  return setupScreen({
    icon: '📌',
    title: 'Setup status',
    sections: [
      ['🧩 Content setup', formatParserStatusLines(draft.parsing || {}, meta)],
      ['📣 Publishing', formatPublishingStatusLines(draft.publish || {}, baseConfig)],
      ['🧪 Validation', formatValidationStatusLines(draft, meta)],
      ['➡️ Next', [
        isPreviewStale(meta)
          ? 'Preview is stale after changes. Run Preview from Check & save before Save.'
          : 'Run Doctor or Preview before saving if you changed the draft.',
        'Home is navigation; Status is only this health summary.'
      ]]
    ]
  });
}

export function formatCheckAndSave(draft, baseConfig = {}, meta = createSetupMeta()) {
  const validation = formatValidationStatusLines(draft, meta);
  return setupScreen({
    icon: '✅',
    title: 'Check & save',
    sections: [
      ['📌 Current state', formatSetupStatusLines(draft, baseConfig, meta)],
      ['🧪 Checks', validation],
      ['➡️ Recommended order', [
        '1. Status: read the concise draft summary.',
        '2. Doctor: catch obvious config/content/schedule issues.',
        '3. Test content: verify parser matches real messages.',
        '4. Preview: inspect final output before Save.'
      ]]
    ]
  });
}

export function formatParserStatusLines(parsing, meta = createSetupMeta()) {
  const lines = [
    `Filters: ${countRules(parsing.filters)} rule(s).`,
    `Author: ${countRules(parsing.author)} rule(s).`,
    `Reactions: ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`
  ];
  if (meta.changedArea === 'parser') lines.push('⚠️ Content setup changed after the last test/preview.');
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
  lines.push(meta.testedAt ? `Content test: ${formatRelativeSetupTime(meta.testedAt)}.` : 'Content test: not run in this setup session.');
  lines.push(meta.previewedAt ? `Preview: ${formatRelativeSetupTime(meta.previewedAt)}.` : 'Preview: not run in this setup session.');
  if (isPreviewStale(meta)) lines.push('⚠️ Preview is stale after draft changes.');
  return lines;
}

export function formatParserMenu(draft) {
  const parsing = draft.parsing || {};
  return setupScreen({
    icon: '🧩',
    title: 'Content setup',
    sections: [
      ['📌 Current content rules', [
        `Filters: ${countRules(parsing.filters)} rule(s).`,
        `Author: ${countRules(parsing.author)} rule(s).`,
        `Reactions: ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`
      ]],
      ['✨ Recommended', [
        'Quick setup scans recent source messages and suggests filters, author extraction, and reaction parsing together.'
      ]],
      ['🛠 Manual tuning', [
        'Filters decide which messages become posts.',
        'Author decides the {{author}} value in captions.',
        'Reactions decide likes/dislikes and ranking scores.'
      ]],
      ['🧪 Checks / advanced', [
        'Run Test content and Preview after changes.',
        'Open Diagnostics only when normal options do not explain enough.'
      ]]
    ]
  });
}

export function formatFiltersMenu(draft) {
  const filters = draft.parsing?.filters || [];
  return setupScreen({
    icon: '🔎',
    title: 'Content filters',
    sections: [
      ['📌 Current filters', [`${countRules(filters)} filter rule(s).`]],
      ['🎯 Purpose', ['Filters decide which Telegram messages become candidate posts.', 'They do not decide author names or reaction scores.']],
      ['➡️ Next', ['Open Filter options or Filter impact, then run Test content.']]
    ]
  });
}

export function formatAuthorMenu(draft) {
  const author = draft.parsing?.author || [];
  return setupScreen({
    icon: '👤',
    title: 'Author setup',
    sections: [
      ['📌 Current author extraction', [`${countRules(author)} author rule(s).`]],
      ['🎯 Purpose', ['Author rules decide what {{author}} means in published captions.', 'Good options are label lines, Telegram mentions, @username, or sender fallback.']],
      ['➡️ Next', ['Open Author options, choose one method, then run Test author.']]
    ]
  });
}

export function formatReactionsMenu(draft) {
  const parsing = draft.parsing || {};
  return setupScreen({
    icon: '👍',
    title: 'Reaction setup',
    sections: [
      ['📌 Current reaction parsing', [`${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`]],
      ['🎯 Purpose', ['Reaction rules decide likes/dislikes and ranking scores.', 'Options include button counters and native Telegram reactions.']],
      ['➡️ Next', ['Open Reaction options, choose a mode, then run Test reactions.']]
    ]
  });
}

export function formatTechnicalDiagnosticsMenu() {
  return setupScreen({
    icon: '🧭',
    title: 'Diagnostics',
    sections: [
      ['🔎 Explain parsing', [
        'Why matched / Why rejected show parser trace for concrete messages.',
        'Unknown author and Zero likes focus on common setup failures.'
      ]],
      ['🧩 Inspect messages', [
        'Message browser lets you pick a concrete loaded message.',
        'Reaction fields and Author fields summarize useful paths without dumping raw JSON.'
      ]],
      ['🧬 Raw tools', [
        'Raw / advanced tools contains field scan, message shape, raw compact JSON, content config, and Advanced JSON.'
      ]],
      ['➡️ Next', ['Start with Explain parsing. Use Raw tools only when the normal screens are not enough.']]
    ]
  });
}

export function formatTechnicalRawToolsMenu() {
  return setupScreen({
    icon: '🧬',
    title: 'Raw / advanced tools',
    sections: [
      ['📦 Raw inspection', [
        'Field scan shows raw Telegram object paths and coverage.',
        'Message shape summarizes media, buttons, entities, senders, forwards, and replies.',
        'Raw matched and Raw reactions show compact JSON for concrete messages.'
      ]],
      ['⚙️ Exact tuning', [
        'Pending Content Config shows draft parser JSON; Saved Content Config shows the config loaded from disk.',
        'Advanced JSON remains available for exact manual commands.'
      ]],
      ['➡️ Next', ['Go back to Diagnostics when you want trace/reaction/author explanations.']]
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
        `Schedules: ${templates.length}`,
        `Timezone: ${baseConfig.schedule?.timezone || 'default'}`
      ]],
      ['✨ Create', [
        'Recommended presets add/update common schedules.',
        'Traffic suggestions builds schedules from recent or stored post volume.',
        'Manual schedule creates one daily/weekly/twice-weekly/monthly schedule with buttons.'
      ]],
      ['🛠 Manage', [
        'Sources defines reusable post selections such as best, controversial, disliked, and engagement.',
        'Schedules lets you enable, disable, or remove existing publish templates.'
      ]],
      ['🧪 Check', [
        'Schedule preview shows upcoming runs.',
        'Schedule doctor checks conflicts, firstSendAt shifts, and gaps/overlaps.',
        'Source test checks publish.sources[].where against stored posts.'
      ]],
      ['🗓 Current schedules', formatTemplateLines(templates, { includeDisabled: true })]
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
  notes.push(`Content preview: ${preview.posts.length} matched post(s) from ${preview.scanned} scanned message(s).`);
  if (preview.scanned > 0 && preview.posts.length === 0) {
    warnings.push('Content filters matched nothing in recent messages. Filters may be too strict or paths may be wrong.');
  } else if (preview.scanned >= 10 && matchRatio < 0.1) {
    warnings.push('Content filters matched less than 10% of recent messages. This can be fine for strict channels, but check rejected messages if selection looks empty.');
  } else if (preview.scanned >= 10 && matchRatio > 0.9) {
    warnings.push('Content filters matched more than 90% of recent messages. This can be too broad if the source chat contains non-post messages.');
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

