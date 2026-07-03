import { setPublishSources, upsertPublishSource } from '../../core/setupConfig.js';
import { compileSourceWhere, getSourceDefinitions } from '../../core/sourceExpression.js';
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


export function getDraftSources(draft = {}) {
  return Array.isArray(draft?.publish?.sources) ? draft.publish.sources : [];
}

export function hasDraftSource(draft = {}, key) {
  return getDraftSources(draft).some((source) => source.key === key);
}

export function toggleSourcePreset(draft, preset) {
  draft.publish = draft.publish || {};
  const beforePublish = structuredClone(draft.publish || {});
  const current = getDraftSources(draft);
  if (current.some((source) => source.key === preset.key)) {
    setPublishSources(draft, current.filter((source) => source.key !== preset.key));
  } else {
    upsertPublishSource(draft, { key: preset.key, where: preset.where });
  }
  const afterPublish = structuredClone(draft.publish || {});
  return {
    action: current.some((source) => source.key === preset.key) ? 'removed' : 'added',
    beforePublish,
    afterPublish,
    lines: formatPublishChanges(beforePublish, afterPublish, { compact: true })
  };
}

export function resetDraftSources(draft) {
  draft.publish = draft.publish || {};
  const beforePublish = structuredClone(draft.publish || {});
  delete draft.publish.sources;
  const afterPublish = structuredClone(draft.publish || {});
  return {
    beforePublish,
    afterPublish,
    lines: formatPublishChanges(beforePublish, afterPublish, { compact: true })
  };
}

export function parseSourceTextCommand(text = '') {
  const raw = String(text || '').trim();
  const rest = raw.replace(/^\/setsource\s*/i, '').trim();
  if (!rest) throw new Error('Usage: /setsource <key> <where> or /setsource {"key":"custom","where":"likes > 0"}');
  if (rest.startsWith('{')) return JSON.parse(rest);
  const match = rest.match(/^([A-Za-z][A-Za-z0-9_-]{0,31})\s+([\s\S]+)$/);
  if (!match) throw new Error('Usage: /setsource <key> <where>. Example: /setsource positive likes > dislikes and likes >= 10');
  const source = { key: match[1], where: match[2].trim() };
  validateSourceExpression(source);
  return source;
}


export function parseCustomSourceInput(text = '') {
  const raw = String(text || '').trim();
  const [firstLine, ...restLines] = raw.split(/\r?\n/);
  const key = String(firstLine || '').trim();
  const where = restLines.join('\n').trim();
  if (!key || !where) {
    throw new Error('Send source key on the first line and expression on the second line.');
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) {
    throw new Error('Source key must start with a letter and contain only letters, numbers, _ or -; max 32 chars.');
  }
  const source = { key, where };
  validateSourceExpression(source);
  return source;
}

export function validateSourceExpression(source = {}) {
  if (!source.key || typeof source.key !== 'string') throw new Error('Source key must be a non-empty string');
  compileSourceWhere(source.where || 'true');
  return source;
}

export function formatCustomSourceHelp(error = '') {
  return setupScreen({
    icon: '✍️',
    title: 'Add custom source',
    sections: [
      ...(error ? [['❌ Last error', [error]]] : []),
      ['📌 Send source as text', [
        'First line: source key.',
        'Second line: expression.',
        '',
        'Example:',
        'positive',
        'likes > dislikes and likes >= 10'
      ]],
      ['🧮 Allowed expression', [
        'Fields: likes, dislikes.',
        'Operators: > >= < <= = != + - * / % and or not.',
        'Functions: abs(...), min(...), max(...).',
        'Examples: likes > 0; dislikes > likes; likes + dislikes >= 10.'
      ]],
      ['➡️ Next', ['Send the two-line text now, or press Back.']]
    ]
  });
}


export function formatSourcesMenu(draft = {}, baseConfig = {}) {
  const sources = getSourceDefinitionsFromDraft(draft, baseConfig);
  const sourceLines = sources.length
                      ? sources.map((source) => `- ${source.key}: ${source.where || 'true'}`)
                      : ['- no publish sources configured'];
  const draftSources = getDraftSources(draft);
  const presetLines = SOURCE_PRESETS.map((preset) => {
    const current = draftSources.find((source) => source.key === preset.key);
    return `- ${current ? '✓ selected' : '• available'} ${preset.title}: key=${preset.key}, where=${preset.where}`;
  });

  return setupScreen({
    icon: '📦',
    title: 'Publish sources',
    sections: [
      ['📌 Current sources', sourceLines],
      ['✨ Source presets', presetLines],
      ['➡️ Next', ['Click a selected preset again to remove it from draft sources. Use Custom source for your own condition.']]
    ]
  });
}

export function applySourcePreset(draft, preset) {
  return toggleSourcePreset(draft, preset);
}

export function formatAppliedSourcePreset(preset, change) {
  return setupScreen({
    icon: change.action === 'removed' ? '🗑' : '✅',
    title: change.action === 'removed' ? 'Source preset removed' : 'Source preset selected',
    sections: [
      ['📦 Source', [`${preset.key}: ${preset.where}`, preset.description]],
      ['📣 Changed', change.lines],
      ['➡️ Next', ['Run Source test, then choose sources in Add custom schedule.']]
    ]
  });
}

export function formatResetSources(change) {
  return setupScreen({
    icon: '✅',
    title: 'Draft sources reset',
    sections: [
      ['📣 Changed', change.lines],
      ['📌 State', ['Draft publish.sources was removed. Effective defaults from config/defaults may still be available.']],
      ['➡️ Next', ['Select source presets again or add a custom source.']]
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
