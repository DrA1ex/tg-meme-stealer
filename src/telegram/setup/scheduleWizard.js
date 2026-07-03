import { getSourceDefinitions } from '../../core/sourceExpression.js';
import { setPublishTemplate, upsertPublishSource } from '../../core/setupConfig.js';
import { formatPublishChanges, publishTemplate } from './publishPresets.js';
import { formatSchedule, formatTemplateLines, setupScreen } from './formattingBase.js';

const DEFAULT_SOURCE = { key: 'best', where: 'likes > 0' };
const WEEKDAYS = [
  ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']
];
const TIME_OPTIONS = ['10:00', '11:00', '12:00', '20:00', '22:00', '23:00', '00:00'];
const WINDOW_OPTIONS = [12, 24, 48, 84, 168, 720];
const POSTS_PRESETS = {
  small: { label: 'Small · 3/5/10', posts: { min: 3, target: 5, max: 10 } },
  normal: { label: 'Normal · 5/10/20', posts: { min: 5, target: 10, max: 20 } },
  large: { label: 'Large · 10/20/30', posts: { min: 10, target: 20, max: 30 } }
};
const THRESHOLD_PRESETS = {
  none: { label: 'No threshold', reactions: { strategy: 'likes', min: 0, includeAbove: 999999 } },
  soft: { label: 'Soft · 5/20', reactions: { strategy: 'likes', min: 5, includeAbove: 20 } },
  normal: { label: 'Normal · 20/30', reactions: { strategy: 'likes', min: 20, includeAbove: 30 } },
  strict: { label: 'Strict · 30/40', reactions: { strategy: 'likes', min: 30, includeAbove: 40 } }
};

export function createScheduleWizard(draft = {}, baseConfig = {}) {
  const sources = getPublishSources(draft, baseConfig);
  return {
    source: sources[0]?.key || DEFAULT_SOURCE.key,
    cadence: '',
    weekdays: [],
    dayOfMonth: 1,
    time: '',
    windowHours: null,
    postsPreset: 'normal',
    thresholdPreset: 'normal'
  };
}

export function getPublishSources(draft = {}, baseConfig = {}) {
  try {
    const config = {
      ...(baseConfig || {}),
      publish: {
        ...(baseConfig?.publish || {}),
        ...(draft?.publish || {})
      }
    };
    const sources = getSourceDefinitions(config);
    return sources.length ? sources : [DEFAULT_SOURCE];
  } catch {
    const sources = Array.isArray(draft?.publish?.sources) ? draft.publish.sources : [];
    return sources.length ? sources : [DEFAULT_SOURCE];
  }
}

export function formatManualScheduleWizard({ wizard, draft = {}, baseConfig = {}, step = 'source' } = {}) {
  const sources = getPublishSources(draft, baseConfig);
  const current = describeWizard(wizard);
  const stepLines = getStepLines(step, { wizard, sources });
  return setupScreen({
    icon: '🧭',
    title: 'Add custom schedule',
    sections: [
      ['📌 Current choice', current],
      ['🎛 Choose', stepLines],
      ['➡️ Next', ['Build a schedule with buttons. It changes only draft config after confirmation.']]
    ]
  });
}

export function buildManualScheduleTemplates(wizard = {}) {
  const source = wizard.source || DEFAULT_SOURCE.key;
  const cadence = wizard.cadence || 'daily';
  const time = wizard.time || defaultTimeForCadence(cadence);
  const windowHours = Number(wizard.windowHours || defaultWindowForCadence(cadence));
  const posts = POSTS_PRESETS[wizard.postsPreset || 'normal']?.posts || POSTS_PRESETS.normal.posts;
  const reactions = THRESHOLD_PRESETS[wizard.thresholdPreset || 'normal']?.reactions || THRESHOLD_PRESETS.normal.reactions;
  const strategy = source.includes('controversial') || source.includes('engagement') ? 'sum' : reactions.strategy;
  const finalReactions = { ...reactions, strategy };

  if (cadence === 'weekly') {
    const weekday = Number(wizard.weekdays?.[0] || 1);
    return [makeTemplate({ source, key: `weekly_${source}_${weekday}`, schedule: { type: 'weekly', weekday, time }, windowHours, posts, reactions: finalReactions })];
  }

  if (cadence === 'twice_weekly') {
    const days = wizard.weekdays?.length ? wizard.weekdays : [1, 4];
    return days.map((weekday) => makeTemplate({ source, key: `twice_weekly_${source}_${weekday}`, schedule: { type: 'weekly', weekday: Number(weekday), time }, windowHours, posts, reactions: finalReactions }));
  }

  if (cadence === 'monthly') {
    const dayOfMonth = Number(wizard.dayOfMonth || 1);
    return [makeTemplate({ source, key: `monthly_${source}_${dayOfMonth}`, schedule: { type: 'monthly', dayOfMonth, time }, windowHours, posts, reactions: finalReactions })];
  }

  return [makeTemplate({ source, key: `daily_${source}_${time.replace(':', '')}`, schedule: { type: 'daily', time }, windowHours, posts, reactions: finalReactions })];
}

export function formatManualScheduleConfirm(wizard = {}) {
  const templates = buildManualScheduleTemplates(wizard);
  return setupScreen({
    icon: '✅',
    title: 'Create custom schedule?',
    sections: [
      ['📣 Templates', formatTemplateLines(templates, { includeDisabled: true })],
      ['📌 Selection', [
        `Source: ${wizard.source || DEFAULT_SOURCE.key}`,
        `Window: ${Number(wizard.windowHours || defaultWindowForCadence(wizard.cadence))}h`,
        `Posts: ${POSTS_PRESETS[wizard.postsPreset || 'normal']?.label || POSTS_PRESETS.normal.label}`,
        `Threshold: ${THRESHOLD_PRESETS[wizard.thresholdPreset || 'normal']?.label || THRESHOLD_PRESETS.normal.label}`
      ]],
      ['➡️ Next', ['Confirm to add/update these templates in the draft config.']]
    ]
  });
}

export function applyManualSchedule(draft, wizard = {}) {
  draft.publish = draft.publish || {};
  const beforePublish = structuredClone(draft.publish || {});
  upsertPublishSource(draft, DEFAULT_SOURCE);
  const templates = buildManualScheduleTemplates(wizard);
  for (const template of templates) setPublishTemplate(draft, template);
  const afterPublish = structuredClone(draft.publish || {});
  return {
    templates,
    beforePublish,
    afterPublish,
    lines: formatPublishChanges(beforePublish, afterPublish, { compact: true })
  };
}

export function formatManualScheduleApplied(change) {
  return setupScreen({
    icon: '✅',
    title: 'Custom schedule created',
    sections: [
      ['📣 Added / updated templates', formatTemplateLines(change.templates, { includeDisabled: true })],
      ['📌 Changed', change.lines],
      ['➡️ Next', ['Run Schedule preview / doctor, then Preview before saving.']]
    ]
  });
}

export function normalizeWizardStep(step) {
  return ['source', 'cadence', 'weekday', 'time', 'window', 'posts', 'threshold', 'confirm'].includes(step) ? step : 'source';
}

export function getWizardNextStep(wizard) {
  if (!wizard.source) return 'source';
  if (!wizard.cadence) return 'cadence';
  if ((wizard.cadence === 'weekly' || wizard.cadence === 'twice_weekly') && !wizard.weekdays?.length) return 'weekday';
  if (wizard.cadence === 'monthly' && !wizard.dayOfMonth) return 'weekday';
  if (!wizard.time) return 'time';
  if (!wizard.windowHours) return 'window';
  if (!wizard.postsPreset) return 'posts';
  if (!wizard.thresholdPreset) return 'threshold';
  return 'confirm';
}

export { WEEKDAYS, TIME_OPTIONS, WINDOW_OPTIONS, POSTS_PRESETS, THRESHOLD_PRESETS };

function makeTemplate({ source, key, schedule, windowHours, posts, reactions }) {
  return publishTemplate({
    source,
    key: slugKey(key),
    schedule,
    windowHours,
    posts,
    reactions,
    template: `${titleCase(source)} posts ({{count}})`
  });
}

function describeWizard(wizard = {}) {
  return [
    `Source: ${wizard.source || '<choose source>'}`,
    `Cadence: ${formatCadence(wizard.cadence)}`,
    `Days: ${formatDays(wizard)}`,
    `Time: ${wizard.time || '<choose time>'}`,
    `Window: ${wizard.windowHours ? `${wizard.windowHours}h` : '<choose window>'}`,
    `Posts: ${POSTS_PRESETS[wizard.postsPreset || 'normal']?.label || '<choose posts>'}`,
    `Threshold: ${THRESHOLD_PRESETS[wizard.thresholdPreset || 'normal']?.label || '<choose threshold>'}`
  ];
}

function getStepLines(step, { wizard, sources }) {
  if (step === 'source') return sources.map((source) => `- ${source.key}: ${source.where || 'true'}`);
  if (step === 'cadence') return ['- Daily', '- Weekly', '- Twice weekly', '- Monthly'];
  if (step === 'weekday') {
    if (wizard.cadence === 'monthly') return ['- Day 1', '- Day 7', '- Day 15', '- Day 28'];
    if (wizard.cadence === 'twice_weekly') return ['- Monday + Thursday', '- Tuesday + Friday', '- Wednesday + Saturday'];
    return WEEKDAYS.map(([, label]) => `- ${label}`);
  }
  if (step === 'time') return TIME_OPTIONS.map((time) => `- ${time}`);
  if (step === 'window') return WINDOW_OPTIONS.map((hours) => `- ${hours}h`);
  if (step === 'posts') return Object.values(POSTS_PRESETS).map((preset) => `- ${preset.label}`);
  if (step === 'threshold') return Object.values(THRESHOLD_PRESETS).map((preset) => `- ${preset.label}`);
  return ['- Review and create.'];
}

function defaultTimeForCadence(cadence) {
  return cadence === 'monthly' || cadence === 'weekly' || cadence === 'twice_weekly' ? '10:00' : '23:00';
}

function defaultWindowForCadence(cadence) {
  if (cadence === 'weekly') return 168;
  if (cadence === 'twice_weekly') return 84;
  if (cadence === 'monthly') return 720;
  return 24;
}

function formatCadence(cadence) {
  if (!cadence) return '<choose cadence>';
  return cadence.replace(/_/g, ' ');
}

function formatDays(wizard = {}) {
  if (wizard.cadence === 'monthly') return wizard.dayOfMonth ? `day ${wizard.dayOfMonth}` : '<choose day>';
  if (wizard.cadence === 'weekly' || wizard.cadence === 'twice_weekly') {
    const map = new Map(WEEKDAYS);
    return wizard.weekdays?.length ? wizard.weekdays.map((day) => map.get(String(day)) || day).join(' + ') : '<choose weekday(s)>';
  }
  return 'every day';
}

function titleCase(value) {
  return String(value || 'Selected').replace(/[_-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function slugKey(value) {
  return String(value || 'custom_schedule').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'custom_schedule';
}
