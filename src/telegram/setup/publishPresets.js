import { setPublishTemplate, upsertPublishSource } from '../../core/setupConfig.js';
import { formatSchedule, formatTemplateLines, formatTemplateTiming, setupScreen } from './formattingBase.js';


export const PUBLISH_PRESETS = [
  {
    id: 'daily_top',
    title: 'Daily top',
    description: 'One daily best selection. Good when you want a single fresh digest every day.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_best',
        schedule: { type: 'daily', time: '11:00' },
        windowHours: 24,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} fresh posts'
      })
    ],
    notes: ['Publishes every day at 11:00 and looks back 24 hours.']
  },
  {
    id: 'morning_night_top',
    title: 'Morning + night top',
    description: 'Two daily best selections with non-overlapping 12h windows.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '11:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} night fresh posts'
      })
    ],
    notes: ['Morning publishes at 11:00 for the previous 12h.', 'Night publishes at 23:00 for the previous 12h.']
  },
  {
    id: 'daily_top_night',
    title: 'Daily top · night digest',
    description: 'One daily best selection late in the evening. Useful when most posts appear during the day.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 24,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} posts from the last 24h'
      })
    ],
    notes: ['Publishes every day at 23:00 and looks back 24 hours.']
  },
  {
    id: 'daily_top_soft',
    title: 'Daily top · soft threshold',
    description: 'A more permissive daily digest for smaller chats or low reaction volume.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 24,
        posts: { min: 3, target: 5, max: 10 },
        reactions: { strategy: 'likes', min: 5, includeAbove: 20 },
        template: 'Best {{count}} posts from the last 24h'
      })
    ],
    notes: ['Soft threshold: min=5 likes, expands above 20 likes.']
  },
  {
    id: 'morning_night_early',
    title: 'Morning + night · early',
    description: 'Two daily selections at 10:00 and 22:00 with 12h windows.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '10:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '22:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} night fresh posts'
      })
    ],
    notes: ['Earlier split: 10:00 / 22:00.']
  },
  {
    id: 'morning_night_late',
    title: 'Morning + night · late',
    description: 'Two daily selections at 12:00 and 00:00 with 12h windows.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '12:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '00:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} night fresh posts'
      })
    ],
    notes: ['Later split: 12:00 / 00:00.']
  },
  {
    id: 'morning_night_soft',
    title: 'Morning + night · soft threshold',
    description: 'Two daily selections for lower reaction volume.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '11:00' },
        windowHours: 12,
        posts: { min: 3, target: 5, max: 10 },
        reactions: { strategy: 'likes', min: 5, includeAbove: 20 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 12,
        posts: { min: 3, target: 5, max: 10 },
        reactions: { strategy: 'likes', min: 5, includeAbove: 20 },
        template: 'Best {{count}} night fresh posts'
      })
    ],
    notes: ['Soft threshold: min=5 likes, expands above 20 likes.']
  },
  {
    id: 'morning_night_strict',
    title: 'Morning + night · strict threshold',
    description: 'Two daily selections for high-volume chats where only stronger posts should pass.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '11:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} night fresh posts'
      })
    ],
    notes: ['Strict threshold: min=30 likes, expands above 40 likes.']
  },
  {
    id: 'weekly_top',
    title: 'Weekly top',
    description: 'One weekly best selection on Monday morning.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'weekly_best',
        schedule: { type: 'weekly', weekday: 1, time: '10:30' },
        windowHours: 168,
        posts: { min: 5, target: 10, max: 15 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} posts from the last week'
      })
    ],
    notes: ['Publishes every Monday at 10:30 and looks back 7 days.']
  },
  {
    id: 'monthly_top',
    title: 'Monthly top',
    description: 'One monthly best selection on the first day of the month.',
    sources: [{ key: 'best', where: 'likes > 0' }],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'monthly_best',
        schedule: { type: 'monthly', dayOfMonth: 1, time: '10:00' },
        windowHours: 720,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} posts from the last month'
      })
    ],
    notes: ['Publishes on day 1 at 10:00 and looks back about 30 days.']
  },
  {
    id: 'monthly_controversial',
    title: 'Monthly controversial',
    description: 'One monthly selection for posts with close like/dislike counts.',
    sources: [{ key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.25' }],
    templates: [
      publishTemplate({
        source: 'controversial',
        key: 'monthly_controversial',
        schedule: { type: 'monthly', dayOfMonth: 1, time: '10:30' },
        windowHours: 720,
        posts: { min: 3, target: 5, max: 15 },
        reactions: { strategy: 'sum', min: 0, includeAbove: 50 },
        template: 'Most controversial posts from the last month ({{count}})'
      })
    ],
    notes: ['Uses source where abs(likes - dislikes) < max(likes, dislikes) * 0.25.', 'Ranks by total reactions.']
  },
  {
    id: 'full_rankings',
    title: 'Full rankings pack',
    description: 'Monthly, weekly, morning/night, and monthly controversial selections together.',
    sources: [
      { key: 'best', where: 'likes > 0' },
      { key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.25' }
    ],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'monthly_best',
        schedule: { type: 'monthly', dayOfMonth: 1, time: '10:00' },
        windowHours: 720,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} posts from the last month'
      }),
      publishTemplate({
        source: 'best',
        key: 'weekly_best',
        schedule: { type: 'weekly', weekday: 1, time: '10:30' },
        windowHours: 168,
        posts: { min: 5, target: 10, max: 15 },
        reactions: { strategy: 'likes', min: 30, includeAbove: 40 },
        template: 'Best {{count}} posts from the last week'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_morning_best',
        schedule: { type: 'daily', time: '11:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} morning fresh posts'
      }),
      publishTemplate({
        source: 'best',
        key: 'daily_night_best',
        schedule: { type: 'daily', time: '23:00' },
        windowHours: 12,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} night fresh posts'
      }),
      publishTemplate({
        source: 'controversial',
        key: 'monthly_controversial',
        schedule: { type: 'monthly', dayOfMonth: 1, time: '10:30' },
        windowHours: 720,
        posts: { min: 3, target: 5, max: 15 },
        reactions: { strategy: 'sum', min: 0, includeAbove: 50 },
        template: 'Most controversial posts from the last month ({{count}})'
      })
    ],
    notes: ['Good starting point when you want all common rankings.', 'Use Replace templates if you want this to be the whole publish.template list.']
  }
];

export function publishTemplate(template) {
  return {
    enabled: true,
    ...template
  };
}

export function getPublishPreset(presetId) {
  return PUBLISH_PRESETS.find((preset) => preset.id === presetId) || null;
}

export function formatPublishPresetsMenu(draft = {}) {
  const templates = Array.isArray(draft.publish?.template) ? draft.publish.template : [];
  return setupScreen({
    icon: '📦',
    title: 'Publish presets',
    sections: [
      ['📌 Current state', [`Current templates: ${templates.length}.`]],
      ['🧱 Presets', PUBLISH_PRESETS.map((preset) => `- ${preset.title}: ${preset.description}`)],
      ['ℹ️ Modes', [
        'Apply/update keeps existing unrelated templates and upserts matching keys.',
        'Replace all templates uses the selected preset as the full publish.template list.'
      ]],
      ['➡️ Next', ['Choose a preset, review the summary, then apply it with one button.']]
    ]
  });
}

export function formatPublishPresetDetails(preset, draft = {}) {
  const existingTemplates = new Set((draft.publish?.template || []).map((template) => template.key));
  const existingSources = new Set((draft.publish?.sources || []).map((source) => source.key));
  const sourceLines = (preset.sources || []).map((source) => {
    const status = existingSources.has(source.key) ? 'already exists; current where will be kept' : 'will add if missing';
    return `- ${source.key}: ${status}; default where=${source.where || 'true'}`;
  });
  const templateLines = (preset.templates || []).map((template) => {
    const status = existingTemplates.has(template.key) ? 'update existing' : 'add new';
    return `- ${template.key}: ${status}; ${formatSchedule(template.schedule)}${formatTemplateTiming(template)}`;
  });
  const selectionLines = (preset.templates || []).map((template) => {
    return `- ${template.key}: posts=${formatPostsConfig(template.posts)}, reactions=${formatReactionsConfig(template.reactions)}`;
  });

  return setupScreen({
    icon: '📦',
    title: `Preset · ${preset.title}`,
    sections: [
      ['📌 Summary', [preset.description]],
      ['🧱 Sources', sourceLines.length ? sourceLines : ['none']],
      ['🗓 Templates', templateLines.length ? templateLines : ['none']],
      ['🎚 Selection', selectionLines.length ? selectionLines : ['none']],
      ...(preset.notes?.length ? [['📝 Notes', preset.notes.map((note) => `- ${note}`)]] : []),
      ['➡️ Next', [
        'Apply/update is safe for existing unrelated templates.',
        'Replace all templates is destructive and asks for confirmation.'
      ]]
    ]
  });
}

export function formatConfirmReplacePublishPreset(preset, currentCount) {
  return setupScreen({
    icon: '⚠️',
    title: 'Replace publish templates?',
    sections: [
      ['📦 Preset', [preset.title]],
      ['🗑 What will happen', [
        `Current publish.template entries: ${currentCount}.`,
        `New publish.template entries: ${(preset.templates || []).length}.`,
        'All other templates will be removed from the draft.',
        'Sources are not cleaned up; missing preset sources will be added.'
      ]],
      ['➡️ Next', ['Confirm only if you want this preset to become the whole schedule.']]
    ]
  });
}

export function applyPublishPresetToDraft(draft, preset, { replace = false } = {}) {
  draft.publish = draft.publish || {};
  draft.publish.sources = Array.isArray(draft.publish.sources) ? draft.publish.sources : [];
  draft.publish.template = replace ? [] : (Array.isArray(draft.publish.template) ? draft.publish.template : []);

  for (const source of preset.sources || []) {
    ensurePublishSource(draft, source);
  }

  for (const template of preset.templates || []) {
    setPublishTemplate(draft, structuredClone(template));
  }
}

export function ensurePublishSource(draft, source) {
  draft.publish = draft.publish || {};
  draft.publish.sources = Array.isArray(draft.publish.sources) ? draft.publish.sources : [];
  if (draft.publish.sources.some((item) => item.key === source.key)) return;
  upsertPublishSource(draft, source);
}

export function formatAppliedPublishPreset({ preset, beforePublish, afterPublish, replace }) {
  return setupScreen({
    icon: '✅',
    title: replace ? 'Publish templates replaced' : 'Publish preset applied',
    sections: [
      ['📦 Preset', [preset.title]],
      ['📌 Changed', formatPublishChanges(beforePublish, afterPublish, { compact: true })],
      ['➡️ Next', ['Run Doctor to validate schedules, then Preview to inspect selected posts before saving.', 'Use Show last change for technical details.']]
    ]
  });
}

export function formatPublishChanges(beforePublish = {}, afterPublish = {}, { compact = false } = {}) {
  const lines = [];
  const beforeSources = mapByKey(beforePublish.sources || []);
  const afterSources = mapByKey(afterPublish.sources || []);
  const beforeTemplates = mapByKey(beforePublish.template || []);
  const afterTemplates = mapByKey(afterPublish.template || []);

  const addedSources = [...afterSources.keys()].filter((key) => !beforeSources.has(key));
  const updatedSources = [...afterSources.keys()].filter((key) => beforeSources.has(key) && JSON.stringify(beforeSources.get(key)) !== JSON.stringify(afterSources.get(key)));
  const removedSources = [...beforeSources.keys()].filter((key) => !afterSources.has(key));
  const addedTemplates = [...afterTemplates.keys()].filter((key) => !beforeTemplates.has(key));
  const updatedTemplates = [...afterTemplates.keys()].filter((key) => beforeTemplates.has(key) && JSON.stringify(beforeTemplates.get(key)) !== JSON.stringify(afterTemplates.get(key)));
  const removedTemplates = [...beforeTemplates.keys()].filter((key) => !afterTemplates.has(key));

  lines.push(`- sources: ${beforeSources.size} → ${afterSources.size}`);
  if (addedSources.length) lines.push(`  added: ${addedSources.join(', ')}`);
  if (updatedSources.length) lines.push(`  updated: ${updatedSources.join(', ')}`);
  if (removedSources.length) lines.push(`  removed: ${removedSources.join(', ')}`);

  lines.push(`- templates: ${beforeTemplates.size} → ${afterTemplates.size}`);
  if (addedTemplates.length) lines.push(`  added: ${addedTemplates.join(', ')}`);
  if (updatedTemplates.length) lines.push(`  updated: ${updatedTemplates.join(', ')}`);
  if (removedTemplates.length) lines.push(`  removed: ${removedTemplates.join(', ')}`);

  if (compact) return lines;

  for (const key of [...addedTemplates, ...updatedTemplates].slice(0, 8)) {
    const template = afterTemplates.get(key);
    lines.push(`  ${key}: ${formatSchedule(template.schedule)}${formatTemplateTiming(template)}, posts=${formatPostsConfig(template.posts)}, reactions=${formatReactionsConfig(template.reactions)}`);
  }
  if (addedTemplates.length + updatedTemplates.length > 8) {
    lines.push(`  ...and ${addedTemplates.length + updatedTemplates.length - 8} more changed template(s)`);
  }

  if (lines.length === 2 && !addedSources.length && !updatedSources.length && !removedSources.length && !addedTemplates.length && !updatedTemplates.length && !removedTemplates.length) {
    lines.push('- no changes');
  }

  return lines;
}

export function mapByKey(items) {
  return new Map((Array.isArray(items) ? items : [])
    .filter((item) => item?.key)
    .map((item) => [item.key, item]));
}

export function formatPostsConfig(posts = {}) {
  return `${posts.min ?? '?'}-${posts.target ?? '?'}-${posts.max ?? '?'}`;
}

export function formatReactionsConfig(reactions = {}) {
  return `${reactions.strategy || 'likes'} min=${reactions.min ?? 0} includeAbove=${reactions.includeAbove ?? '∞'}`;
}
