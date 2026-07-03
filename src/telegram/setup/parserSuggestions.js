import { getReactionCount, getReactionEmoji } from '../../core/postParser.js';
import { button, inlineKeyboard } from './keyboards.js';
import { setupScreen } from './formattingBase.js';

export const NATIVE_REACTION_PATHS = ['reactions.results[]', 'reaction_count[]', 'reactionCounts[]'];

export const CONSERVATIVE_LIKE_EMOJIS = ['👍', '❤', '❤️', '🔥'];
export const CONSERVATIVE_DISLIKE_EMOJIS = ['👎'];
export const BROAD_LIKE_EMOJIS = ['👍', '❤', '❤️', '🔥', '😂', '😁', '😍', '🥰', '👏', '🎉'];
export const BROAD_DISLIKE_EMOJIS = ['👎', '💩', '🤡', '🤮', '😡'];
export const NEGATIVE_ONLY_EMOJIS = ['👎', '💩', '🤡'];

export function buildParserSuggestions(messages, draft = {}) {
  const stats = analyzeMessagesForParser(messages);
  const suggestions = [];

  const recommendedFilters = [{ source: 'message', transform: 'hasContent' }];
  if (stats.mediaCount > 0 && stats.mediaCount / Math.max(1, stats.scanned) >= 0.4) {
    recommendedFilters.push({ source: 'message', transform: 'hasMedia' });
  }
  if (stats.topSender && stats.topSender.count / Math.max(1, stats.scanned) >= 0.5) {
    recommendedFilters.push({ source: 'sender', path: 'id', transform: 'equals', value: stats.topSender.id });
  }

  const authorSuggestion = buildAuthorSuggestion(stats);
  const buttonReactionSuggestion = buildReactionSuggestion(stats);
  const nativeReactionSuggestions = buildNativeReactionSuggestions(stats);
  const reactionSuggestion = buttonReactionSuggestion || nativeReactionSuggestions[0];

  suggestions.push({
    id: 'rec',
    title: 'Apply suggested parser',
    description: [
      `Set ${recommendedFilters.length} filter rule(s)`,
      authorSuggestion ? 'set author detection' : 'keep current author rules',
      reactionSuggestion ? `set ${reactionSuggestion.kind || 'reaction'} parsing` : 'keep current reaction rules'
    ].join(', '),
    recommended: true,
    apply: (draftConfig) => {
      draftConfig.parsing.filters = structuredClone(recommendedFilters);
      if (authorSuggestion) draftConfig.parsing.author = structuredClone(authorSuggestion.rules);
      if (reactionSuggestion) {
        draftConfig.parsing.likes = structuredClone(reactionSuggestion.likesRules);
        draftConfig.parsing.dislikes = structuredClone(reactionSuggestion.dislikesRules);
      }
    },
    afterApply: 'Suggested filters/extractors were applied. Run Test parser, then Preview.'
  });

  suggestions.push({
    id: 'f_content',
    title: 'Add hasContent filter',
    description: `${stats.contentCount}/${stats.scanned} recent messages have text or supported media`,
    apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', { source: 'message', transform: 'hasContent' })
  });

  if (stats.mediaCount > 0) {
    suggestions.push({
      id: 'f_media',
      title: 'Add hasMedia filter',
      description: `${stats.mediaCount}/${stats.scanned} recent messages have photo/video media`,
      apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', { source: 'message', transform: 'hasMedia' })
    });
  }

  if (stats.topSender) {
    suggestions.push({
      id: 'f_sender',
      title: `Add top sender filter`,
      description: `sender ${stats.topSender.id} appears in ${stats.topSender.count}/${stats.scanned} recent messages${stats.topSender.label ? ` (${stats.topSender.label})` : ''}`,
      apply: (draftConfig) => addUniqueParsingRule(draftConfig, 'filters', {
        source: 'sender',
        path: 'id',
        transform: 'equals',
        value: stats.topSender.id
      })
    });
  }

  if (authorSuggestion) {
    suggestions.push({
      id: 'a_line',
      title: authorSuggestion.title,
      description: authorSuggestion.description,
      apply: (draftConfig) => {
        draftConfig.parsing.author = structuredClone(authorSuggestion.rules);
      }
    });
  }

  if (stats.senderNameCount > 0) {
    suggestions.push({
      id: 'a_name',
      title: 'Use sender first name as author',
      description: `${stats.senderNameCount}/${stats.scanned} recent messages have sender.firstName`,
      apply: (draftConfig) => {
        draftConfig.parsing.author = [{ source: 'sender', path: 'firstName', transform: 'trim' }];
      }
    });
  }

  if (stats.senderUsernameCount > 0) {
    suggestions.push({
      id: 'a_user',
      title: 'Use sender username as author',
      description: `${stats.senderUsernameCount}/${stats.scanned} recent messages have sender.username`,
      apply: (draftConfig) => {
        draftConfig.parsing.author = [{ source: 'sender', path: 'username', regex: '(.+)', group: 1, transform: 'telegramUsername' }];
      }
    });
  }

  if (buttonReactionSuggestion) {
    suggestions.push({
      id: 'r_buttons',
      title: buttonReactionSuggestion.title,
      description: buttonReactionSuggestion.description,
      apply: (draftConfig) => {
        draftConfig.parsing.likes = structuredClone(buttonReactionSuggestion.likesRules);
        draftConfig.parsing.dislikes = structuredClone(buttonReactionSuggestion.dislikesRules);
      }
    });
  }

  for (const nativeSuggestion of nativeReactionSuggestions) {
    suggestions.push({
      id: nativeSuggestion.id,
      title: nativeSuggestion.title,
      description: nativeSuggestion.description,
      apply: (draftConfig) => {
        draftConfig.parsing.likes = structuredClone(nativeSuggestion.likesRules);
        draftConfig.parsing.dislikes = structuredClone(nativeSuggestion.dislikesRules);
      }
    });
  }

  return suggestions;
}

export function analyzeMessagesForParser(messages) {
  const stats = {
    scanned: messages.length,
    contentCount: 0,
    mediaCount: 0,
    senderNameCount: 0,
    senderUsernameCount: 0,
    senderCounts: new Map(),
    senderLabels: new Map(),
    authorLines: [],
    buttonPaths: new Map(),
    nativeReactionPaths: new Map()
  };

  for (const message of messages) {
    if (hasSetupContent(message)) stats.contentCount += 1;
    if (hasSetupMedia(message)) stats.mediaCount += 1;

    const sender = message?.sender || null;
    const senderId = getSetupSenderId(message);
    if (senderId) {
      stats.senderCounts.set(senderId, (stats.senderCounts.get(senderId) || 0) + 1);
      const label = formatSetupSenderLabel(sender);
      if (label) stats.senderLabels.set(senderId, label);
    }
    if (sender?.firstName) stats.senderNameCount += 1;
    if (sender?.username) stats.senderUsernameCount += 1;

    const textValues = [
      { path: 'text', value: message?.text || '' },
      { path: 'message', value: message?.message || '' }
    ];
    for (const item of textValues) {
      for (const pattern of getAuthorLinePatterns()) {
        if (pattern.regex.test(item.value)) {
          stats.authorLines.push({ path: item.path, label: pattern.label, regex: pattern.ruleRegex });
        }
      }
    }

    for (const path of ['markup.buttons[].text', 'replyMarkup.rows[].buttons[].text']) {
      const values = getSetupValuesByPath(message, path).filter((value) => String(value || '').trim());
      if (!values.length) continue;
      const current = stats.buttonPaths.get(path) || [];
      current.push(...values.map(String));
      stats.buttonPaths.set(path, current);
    }

    for (const path of NATIVE_REACTION_PATHS) {
      const values = getSetupValuesByPath(message, path).filter((value) => getReactionEmoji(value) && getReactionCount(value) > 0);
      if (!values.length) continue;
      const current = stats.nativeReactionPaths.get(path) || [];
      current.push(...values);
      stats.nativeReactionPaths.set(path, current);
    }
  }

  stats.topSender = getTopSender(stats.senderCounts, stats.senderLabels);
  return stats;
}

export function buildAuthorSuggestion(stats) {
  const counts = new Map();
  for (const item of stats.authorLines) {
    const key = `${item.path}\t${item.label}\t${item.regex}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;

  const [path, label, regex] = best[0].split('\t');
  const count = best[1];
  return {
    title: `Use "${label}" line as author`,
    description: `${count}/${stats.scanned} recent messages contain this author line on message.${path}`,
    rules: [{ source: 'message', path, regex, group: 1, transform: 'trim' }]
  };
}

export function buildReactionSuggestion(stats) {
  const bestPath = [...stats.buttonPaths.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!bestPath) return null;

  const [path, texts] = bestPath;
  const likeMarkers = getDetectedMarkers(texts, ['👍', '❤', '❤️', '🔥', '+']);
  const dislikeMarkers = getDetectedMarkers(texts, ['👎', '-']);
  if (!likeMarkers.length && !dislikeMarkers.length) return null;

  const likesRules = likeMarkers.length ? buildReactionRules(path, likeMarkers) : [];
  const dislikesRules = dislikeMarkers.length ? buildReactionRules(path, dislikeMarkers) : [];
  return {
    kind: 'reaction button',
    title: 'Use detected reaction buttons',
    description: `path=${path}, likes=${likeMarkers.join(' ') || 'none'}, dislikes=${dislikeMarkers.join(' ') || 'none'}, button texts=${texts.length}`,
    likesRules,
    dislikesRules
  };
}

export function buildReactionRules(path, markers) {
  const markerRegex = markers.map(escapeRegex).join('|');
  return [
    {
      source: 'message',
      path,
      regex: `(?:${markerRegex})\\s*([\\d\\s,.]+[km]?)`,
      group: 1,
      transform: 'count',
      aggregate: 'sum'
    },
    {
      source: 'message',
      path,
      regex: `\\s*([\\d\\s,.]+[km]?)\\s*(?:${markerRegex})`,
      group: 1,
      transform: 'count',
      aggregate: 'sum'
    }
  ];
}


export function buildNativeReactionSuggestions(stats) {
  const bestPath = [...(stats.nativeReactionPaths || new Map()).entries()]
    .map(([path, values]) => ({ path, values }))
    .sort((a, b) => b.values.length - a.values.length)[0];
  if (!bestPath) return [];

  const counts = countNativeReactionEmojis(bestPath.values);
  if (!counts.length) return [];
  const summary = counts.slice(0, 8).map(([emoji, count]) => `${emoji}=${count}`).join(' ');
  const path = bestPath.path;
  const baseDescription = `path=${path}, reactions=${bestPath.values.length}, ${summary}`;
  return [
    {
      id: 'r_native_conservative',
      kind: 'native reaction',
      title: 'Use native reactions · conservative',
      description: `${baseDescription}; likes=${CONSERVATIVE_LIKE_EMOJIS.join(' ')}, dislikes=${CONSERVATIVE_DISLIKE_EMOJIS.join(' ')}`,
      ...buildNativeReactionRules(path, {
        likeEmojis: CONSERVATIVE_LIKE_EMOJIS,
        dislikeEmojis: CONSERVATIVE_DISLIKE_EMOJIS
      })
    },
    {
      id: 'r_native_broad',
      kind: 'native reaction',
      title: 'Use native reactions · broad',
      description: `${baseDescription}; broad positive/negative emoji sets`,
      ...buildNativeReactionRules(path, {
        likeEmojis: BROAD_LIKE_EMOJIS,
        dislikeEmojis: BROAD_DISLIKE_EMOJIS
      })
    },
    {
      id: 'r_native_except_negative',
      kind: 'native reaction',
      title: 'Use native reactions · except 👎💩🤡',
      description: `${baseDescription}; likes=all native emoji except ${NEGATIVE_ONLY_EMOJIS.join(' ')}, dislikes=${NEGATIVE_ONLY_EMOJIS.join(' ')}`,
      ...buildNativeReactionRules(path, {
        likeEmojis: NEGATIVE_ONLY_EMOJIS,
        likeInvert: true,
        dislikeEmojis: NEGATIVE_ONLY_EMOJIS
      })
    }
  ];
}

export function buildNativeReactionRules(path, { likeEmojis = [], dislikeEmojis = [], likeInvert = false, dislikeInvert = false } = {}) {
  return {
    likesRules: [buildNativeReactionRule(path, likeEmojis, { invert: likeInvert })],
    dislikesRules: [buildNativeReactionRule(path, dislikeEmojis, { invert: dislikeInvert })]
  };
}

export function buildNativeReactionRule(path, emojis, { invert = false } = {}) {
  return {
    source: 'message',
    path,
    transform: 'reactionCount',
    emojis: [...emojis],
    invert: Boolean(invert),
    aggregate: 'sum'
  };
}

export function countNativeReactionEmojis(values = []) {
  const counts = new Map();
  for (const value of values) {
    const emoji = getReactionEmoji(value);
    const count = getReactionCount(value);
    if (!emoji || count <= 0) continue;
    counts.set(emoji, (counts.get(emoji) || 0) + count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function formatAppliedSuggestion({ suggestion, beforeParsing, afterParsing }) {
  return setupScreen({
    icon: '✅',
    title: 'Suggestion applied',
    sections: [
      ['✨ Applied', [suggestion.title]],
      ['📌 Changed', formatParserChanges(beforeParsing, afterParsing, { compact: true })],
      ['➡️ Next', [suggestion.afterApply || 'Run Test parser or Preview to check the result.', 'Use Show last change for technical details.']]
    ]
  });
}

export function formatNoopSuggestion(suggestion) {
  return setupScreen({
    icon: '✓',
    title: 'No parser changes',
    sections: [
      ['💡 Suggestion', [suggestion.title]],
      ['📌 State', ['This suggestion is already reflected in the current parser draft.']],
      ['➡️ Next', ['Apply another • suggestion, or run Test parser / Preview.']]
    ]
  });
}

export function formatFiltersReset({ beforeParsing, afterParsing, hasSuggestions }) {
  return setupScreen({
    icon: '✅',
    title: 'Filters reset',
    sections: [
      ['📌 Changed', formatParserChanges(beforeParsing, afterParsing, { compact: true })],
      ['➡️ Next', [
        hasSuggestions
          ? 'Apply filter suggestions again from this screen, or run Test parser / Preview.'
          : 'Run Auto suggestions to add filters again.'
      ]]
    ]
  });
}

export function formatParserChanges(beforeParsing, afterParsing, { compact = false } = {}) {
  const sections = ['filters', 'author', 'likes', 'dislikes'];
  const lines = [];
  for (const section of sections) {
    const before = Array.isArray(beforeParsing?.[section]) ? beforeParsing[section] : [];
    const after = Array.isArray(afterParsing?.[section]) ? afterParsing[section] : [];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const action = before.length && after.length ? 'updated' : before.length ? 'cleared' : 'added';
    lines.push(`- ${section}: ${before.length} → ${after.length} rule(s), ${action}.`);
    if (compact) continue;
    for (const rule of after.slice(0, 4)) {
      lines.push(`  ${compactRule(rule)}`);
    }
    if (after.length > 4) lines.push(`  ...and ${after.length - 4} more rule(s)`);
  }
  return lines.length ? lines : ['- No parser changes.'];
}

export function compactRule(rule) {
  const parts = [];
  if (rule.source) parts.push(String(rule.source));
  if (rule.path) parts.push(String(rule.path));
  if (rule.transform) parts.push(`transform=${rule.transform}`);
  if (rule.value !== undefined) parts.push(`value=${JSON.stringify(rule.value)}`);
  if (Array.isArray(rule.values)) parts.push(`values=${JSON.stringify(rule.values)}`);
  if (Array.isArray(rule.emojis)) parts.push(`emojis=${JSON.stringify(rule.emojis)}`);
  if (rule.invert) parts.push('invert=true');
  if (rule.regex) parts.push(`regex=${JSON.stringify(rule.regex)}`);
  return parts.join(' · ') || JSON.stringify(rule);
}

export function formatParserSuggestions({ suggestions, scanned, matched }) {
  const suggestionLines = suggestions.length
    ? suggestions.map((suggestion) => {
      const marker = suggestion.actionable ? '•' : '✓';
      const state = suggestion.actionable ? '' : ' — already applied / no change';
      return `- ${marker} ${suggestion.title}: ${suggestion.description}${state}`;
    })
    : ['- No suggestions found. Use Advanced JSON with /raw or /debug for this source shape.'];

  return setupScreen({
    icon: '✨',
    title: 'Parser auto-suggestions',
    sections: [
      ['🔎 Scan', [`Scanned ${scanned} recent source message(s).`, `Current parser matched ${matched}.`]],
      ['💡 Suggestions', suggestionLines],
      ['ℹ️ Legend', ['• changes the parser draft.', '✓ already matches the current draft and does nothing when clicked.']],
      ['➡️ Next', ['Apply several suggestions from this screen, then run Test parser and Preview before saving.']]
    ]
  });
}

export function parserSuggestionsKeyboard(suggestions) {
  const rows = [];

  if (suggestions.length) {
    const recommended = suggestions.find((suggestion) => suggestion.recommended);
    if (recommended) rows.push([suggestionButton(recommended, { fullTitle: true })]);

    const regular = suggestions.filter((suggestion) => !suggestion.recommended);
    for (let index = 0; index < regular.length; index += 2) {
      rows.push(regular.slice(index, index + 2).map((suggestion) => suggestionButton(suggestion)));
    }
  } else {
    rows.push([button('Advanced JSON', 'setup:advanced')]);
  }

  rows.push([button('Reset filters', 'setup:reset_filters')]);
  rows.push([button('Filter impact', 'setup:filter_impact'), button('Parser paths', 'setup:parser_paths')]);
  rows.push([button('Test parser', 'setup:test'), button('Preview', 'setup:preview')]);
  rows.push([button('Show last change', 'setup:last_change'), button('Show parser config', 'setup:parser_config')]);
  rows.push([button('Advanced JSON', 'setup:advanced'), button('Back', 'setup:parser')]);
  return inlineKeyboard(rows);
}

export function confirmResetFiltersKeyboard() {
  return inlineKeyboard([
    [button('Yes, reset filters', 'setup:reset_filters_confirm')],
    [button('Back to suggestions', 'setup:suggest'), button('Parser', 'setup:parser')]
  ]);
}

export function suggestionButton(suggestion, { fullTitle = false } = {}) {
  const prefix = suggestion.actionable ? '• ' : '✓ ';
  const title = fullTitle ? suggestion.title : shortSuggestionTitle(suggestion.title);
  const action = suggestion.actionable ? `setup:apply:${suggestion.id}` : `setup:noop:${suggestion.id}`;
  return button(`${prefix}${title}`.slice(0, 52), action);
}

export function shortSuggestionTitle(title) {
  return String(title)
    .replace('Add ', '+ ')
    .replace('Use ', 'Use ')
    .replace(' as author', '')
    .replace('detected ', '')
    .slice(0, 32);
}

export function markSuggestionStates(suggestions, draft) {
  return suggestions.map((suggestion) => ({
    ...suggestion,
    actionable: isSuggestionUseful(suggestion, draft)
  }));
}

export function isSuggestionUseful(suggestion, draft) {
  const clone = structuredClone(draft || {});
  const before = JSON.stringify(clone.parsing || {});
  suggestion.apply(clone);
  const after = JSON.stringify(clone.parsing || {});
  return before !== after;
}

export function addUniqueParsingRule(draft, key, rule) {
  draft.parsing[key] = Array.isArray(draft.parsing[key]) ? draft.parsing[key] : [];
  const normalized = JSON.stringify(rule);
  if (!draft.parsing[key].some((item) => JSON.stringify(item) === normalized)) {
    draft.parsing[key].push(structuredClone(rule));
  }
}

export function getAuthorLinePatterns() {
  return [
    { label: 'От ...', regex: /(?:^|\n)\s*От\s+(.+?)(?:\n|$)/i, ruleRegex: '(?:^|\\n)\\s*От\\s+(.+?)(?:\\n|$)' },
    { label: 'By ...', regex: /(?:^|\n)\s*By\s+(.+?)(?:\n|$)/i, ruleRegex: '(?:^|\\n)\\s*By\\s+(.+?)(?:\\n|$)' }
  ];
}

export function hasSetupContent(message) {
  return hasSetupMedia(message) || String(message?.text || message?.message || '').trim().length > 0;
}

export function hasSetupMedia(message) {
  return getSetupMediaKind(message) !== 'text';
}

export function getSetupMediaKind(message) {
  if (message?.media?.type === 'photo' || message?.photo || message?.media?.photo || message?.media?.className === 'MessageMediaPhoto') return 'photo';
  const document = message?.document || message?.media?.document || message?.media;
  const mimeType = document?.mimeType || '';
  if (message?.media?.type === 'video' || message?.video || message?.media?.video || message?.media?.className === 'MessageMediaDocument' && mimeType.startsWith('video/')) return 'video';
  return 'text';
}

export function getSetupSenderId(message) {
  const raw = message?.sender?.id?.value ?? message?.sender?.id ?? message?.senderId?.value ?? message?.senderId ?? message?.fromId?.userId?.value ?? message?.fromId?.userId;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatSetupSenderLabel(sender) {
  if (!sender) return '';
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim();
  if (name && sender.username) return `${name} / @${sender.username}`;
  if (name) return name;
  if (sender.username) return `@${sender.username}`;
  return '';
}

export function getTopSender(senderCounts, senderLabels) {
  const best = [...senderCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  return { id: best[0], count: best[1], label: senderLabels.get(best[0]) || '' };
}

export function getSetupValuesByPath(root, path) {
  if (!path) return [root];
  let values = [root];
  for (const part of path.split('.')) {
    values = resolveSetupPathPart(values, part);
  }
  return values.filter((value) => value !== undefined && value !== null);
}

export function resolveSetupPathPart(values, part) {
  const match = String(part).match(/^([^\[]*)((?:\[\])*)$/);
  const key = match?.[1] || '';
  const arrayDepth = (match?.[2]?.match(/\[\]/g) || []).length;
  let next = values.flatMap((value) => {
    if (!key) return [value];
    if (Array.isArray(value)) return value.flatMap((item) => item?.[key]);
    return [value?.[key]];
  });
  for (let index = 0; index < arrayDepth; index += 1) {
    next = next.flatMap((value) => Array.isArray(value) ? value : []);
  }
  return next;
}

export function getDetectedMarkers(texts, markers) {
  return markers.filter((marker) => texts.some((text) => String(text).includes(marker)));
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
