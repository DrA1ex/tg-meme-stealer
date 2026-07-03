import { upsertPublishSource } from '../../core/setupConfig.js';
import { getSourceDefinitions } from '../../core/sourceExpression.js';
import { formatPublishChanges } from './publishPresets.js';
import { setupScreen } from './formattingBase.js';

export const SOURCE_PRESETS = [
  {
    id: 'best',
    key: 'best',
    title: 'Best / positive',
    where: 'likes > 0',
    description: 'Posts with at least one like. Best default for top selections.'
  },
  {
    id: 'controversial',
    key: 'controversial',
    title: 'Controversial',
    where: 'max(likes, dislikes) > 0 and abs(likes - dislikes) < max(likes, dislikes) * 0.25',
    description: 'Posts with close like/dislike counts.'
  },
  {
    id: 'disliked',
    key: 'disliked',
    title: 'Disliked',
    where: 'dislikes > likes',
    description: 'Posts where dislikes are higher than likes.'
  },
  {
    id: 'engagement',
    key: 'engagement',
    title: 'High engagement',
    where: 'likes + dislikes >= 10',
    description: 'Posts with a meaningful number of total reactions.'
  }
];

export function getSourcePreset(id) {
  return SOURCE_PRESETS.find((preset) => preset.id === id || preset.key === id) || null;
}

export function formatSourcesMenu(draft = {}, baseConfig = {}) {
  const sources = getSourceDefinitionsFromDraft(draft, baseConfig);
  const sourceLines = sources.length
    ? sources.map((source) => `- ${source.key}: ${source.where || 'true'}`)
    : ['- no publish sources configured'];
  const presetLines = SOURCE_PRESETS.map((preset) => {
    const current = sources.find((source) => source.key === preset.key);
    return `- ${current ? '✓' : '•'} ${preset.title}: key=${preset.key}, where=${preset.where}`;
  });

  return setupScreen({
    icon: '📦',
    title: 'Publish sources',
    sections: [
      ['📌 Current sources', sourceLines],
      ['✨ Source presets', presetLines],
      ['➡️ Next', ['Add/update a source preset, then run Source test or use Add custom schedule.']]
    ]
  });
}

export function applySourcePreset(draft, preset) {
  draft.publish = draft.publish || {};
  const beforePublish = structuredClone(draft.publish || {});
  upsertPublishSource(draft, { key: preset.key, where: preset.where });
  const afterPublish = structuredClone(draft.publish || {});
  return {
    beforePublish,
    afterPublish,
    lines: formatPublishChanges(beforePublish, afterPublish, { compact: true })
  };
}

export function formatAppliedSourcePreset(preset, change) {
  return setupScreen({
    icon: '✅',
    title: 'Source preset applied',
    sections: [
      ['📦 Source', [`${preset.key}: ${preset.where}`, preset.description]],
      ['📣 Changed', change.lines],
      ['➡️ Next', ['Run Source test, then choose this source in Add custom schedule.']]
    ]
  });
}

function getSourceDefinitionsFromDraft(draft, baseConfig) {
  try {
    const merged = {
      ...(baseConfig || {}),
      publish: {
        ...(baseConfig?.publish || {}),
        ...(draft?.publish || {})
      }
    };
    return getSourceDefinitions(merged);
  } catch {
    return Array.isArray(draft?.publish?.sources) ? draft.publish.sources : [];
  }
}
