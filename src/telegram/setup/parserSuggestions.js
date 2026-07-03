import { getReactionCount, getReactionEmoji } from '../../core/postParser.js';
import { button, inlineKeyboard } from './keyboards.js';
import { setupScreen } from './formattingBase.js';

export const NATIVE_REACTION_PATHS = ['reactions.results[]', 'reaction_count[]', 'reactionCounts[]'];

export const CONSERVATIVE_LIKE_EMOJIS = ['👍', '❤', '❤️', '🔥'];
export const CONSERVATIVE_DISLIKE_EMOJIS = ['👎'];
export const BROAD_LIKE_EMOJIS = ['👍', '❤', '❤️', '🔥', '😂', '😁', '😍', '🥰', '👏', '🎉'];
export const BROAD_DISLIKE_EMOJIS = ['👎', '💩', '🤡', '🤮', '😡'];
export const NEGATIVE_ONLY_EMOJIS = ['👎', '💩', '🤡'];
export const AUTHOR_LABEL_REGEX = '(?:^|\\n)\\s*(?:от|by|author|автор|from|via|source|источник)\\s*:?\\s*(.+?)(?:\\n|$)';

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

  const authorOptions = buildAuthorSuggestions(stats);
  const authorSuggestion = authorOptions.find((item) => item.recommended) || authorOptions[0] || null;
  const buttonReactionSuggestions = buildButtonReactionSuggestions(stats);
  const nativeReactionSuggestions = buildNativeReactionSuggestions(stats);
  const reactionSuggestion = buttonReactionSuggestions.find((item) => item.recommended)
    || nativeReactionSuggestions.find((item) => item.recommended)
    || buttonReactionSuggestions[0]
    || nativeReactionSuggestions[0];

  suggestions.push({
    id: 'rec',
    title: 'Apply suggested content setup',
    description: [
      `filters: ${recommendedFilters.length} rule(s)`,
      authorSuggestion ? `author: ${authorSuggestion.title.replace('Author · ', '')}` : 'author: keep current',
      reactionSuggestion ? `reactions: ${reactionSuggestion.title.replace('Use ', '')}` : 'reactions: keep current'
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
    afterApply: 'Suggested filters, author, and reaction rules were applied. Run Test content, then Preview.'
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

  for (const option of authorOptions) {
    suggestions.push({
      id: option.id,
      title: option.title,
      description: option.description,
      recommended: Boolean(option.recommended),
      apply: (draftConfig) => {
        draftConfig.parsing.author = structuredClone(option.rules);
      }
    });
  }

  for (const buttonReactionSuggestion of buttonReactionSuggestions) {
    suggestions.push({
      id: buttonReactionSuggestion.id,
      title: buttonReactionSuggestion.title,
      description: buttonReactionSuggestion.description,
      recommended: Boolean(buttonReactionSuggestion.recommended),
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
    mentionNameCount: 0,
    usernameMentionCount: 0,
    mentionExamples: [],
    usernameExamples: [],
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
      const match = String(item.value || '').match(new RegExp(AUTHOR_LABEL_REGEX, 'i'));
      if (match) {
        stats.authorLines.push({ path: item.path, label: 'label line · multilingual', regex: AUTHOR_LABEL_REGEX, example: match[0].trim() });
      }
    }

    const entitySummary = detectAuthorEntities(message);
    if (entitySummary.mentionName) {
      stats.mentionNameCount += 1;
      if (entitySummary.mentionNameExample) stats.mentionExamples.push(entitySummary.mentionNameExample);
    }
    if (entitySummary.username) {
      stats.usernameMentionCount += 1;
      if (entitySummary.usernameExample) stats.usernameExamples.push(entitySummary.usernameExample);
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
  const options = buildAuthorSuggestions(stats);
  return options.find((item) => item.recommended) || options[0] || null;
}

export function buildAuthorSuggestions(stats) {
  const suggestions = [];
  const counts = new Map();
  for (const item of stats.authorLines) {
    const key = `${item.path}\t${item.regex}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    const [path, regex] = best[0].split('\t');
    const count = best[1];
    suggestions.push({
      id: 'a_label_multilingual',
      title: 'Author · label line multilingual',
      description: `${count}/${stats.scanned} messages contain labels like От, By, Author, Автор, From, Via, Source`,
      recommended: count / Math.max(1, stats.scanned) >= 0.45,
      rules: [{ source: 'message', path, regex, group: 1, transform: 'trim', flags: 'i' }]
    });
  }

  if (stats.mentionNameCount > 0) {
    suggestions.push({
      id: 'a_mention_name',
      title: 'Author · Telegram mention / tg://user',
      description: `${stats.mentionNameCount}/${stats.scanned} messages have text_mention, mentionName, or tg://user?id=...${stats.mentionExamples.length ? `; examples: ${unique(stats.mentionExamples).slice(0, 3).join(', ')}` : ''}`,
      recommended: !best && stats.mentionNameCount / Math.max(1, stats.scanned) >= 0.25,
      rules: [{ source: 'message', transform: 'mentionAuthor', values: ['mentionName', 'tgUser'] }]
    });
  }

  if (stats.usernameMentionCount > 0) {
    suggestions.push({
      id: 'a_username_mention',
      title: 'Author · @username mention',
      description: `${stats.usernameMentionCount}/${stats.scanned} messages have @username mention entities${stats.usernameExamples.length ? `; examples: ${unique(stats.usernameExamples).slice(0, 4).join(', ')}` : ''}`,
      recommended: !best && !stats.mentionNameCount && stats.usernameMentionCount / Math.max(1, stats.scanned) >= 0.25,
      rules: [{ source: 'message', transform: 'mentionAuthor', values: ['username'] }]
    });
  }

  if (stats.senderNameCount > 0) {
    suggestions.push({
      id: 'a_name',
      title: 'Author · sender first name',
      description: `${stats.senderNameCount}/${stats.scanned} messages have sender.firstName; often this is the source bot, not the real author`,
      recommended: !best && !stats.mentionNameCount && !stats.usernameMentionCount,
      rules: [{ source: 'sender', path: 'firstName', transform: 'trim' }]
    });
  }

  if (stats.senderUsernameCount > 0) {
    suggestions.push({
      id: 'a_user',
      title: 'Author · sender username',
      description: `${stats.senderUsernameCount}/${stats.scanned} messages have sender.username; fallback option`,
      recommended: false,
      rules: [{ source: 'sender', path: 'username', regex: '(.+)', group: 1, transform: 'telegramUsername' }]
    });
  }

  return suggestions;
}

export function buildReactionSuggestion(stats) {
  return buildButtonReactionSuggestions(stats)[0] || null;
}

export function buildButtonReactionSuggestions(stats) {
  const suggestions = [];
  for (const [path, texts] of [...stats.buttonPaths.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const variants = buildButtonReactionVariants(path, texts);
    suggestions.push(...variants);
  }
  return suggestions;
}

export function buildButtonReactionVariants(path, texts = []) {
  const variants = [];
  const detectedMarkers = getDetectedReactionMarkers(texts);
  const detectedLikeMarkers = detectedMarkers.filter((marker) => !NEGATIVE_ONLY_EMOJIS.includes(marker) && marker !== '-' && marker !== '👎');
  const detectedDislikeMarkers = detectedMarkers.filter((marker) => NEGATIVE_ONLY_EMOJIS.includes(marker) || marker === '-' || marker === '👎');
  const conservativeLikeMarkers = getDetectedMarkers(texts, CONSERVATIVE_LIKE_EMOJIS.concat('+'));
  const conservativeDislikeMarkers = getDetectedMarkers(texts, CONSERVATIVE_DISLIKE_EMOJIS.concat('-'));
  const broadLikeMarkers = getDetectedMarkers(texts, BROAD_LIKE_EMOJIS.concat('+'));
  const broadDislikeMarkers = getDetectedMarkers(texts, BROAD_DISLIKE_EMOJIS.concat('-'));

  addButtonReactionVariant(variants, {
    id: 'r_buttons_detected',
    path,
    texts,
    title: 'Reactions · button counters · detected markers',
    likeMarkers: detectedLikeMarkers,
    dislikeMarkers: detectedDislikeMarkers,
    recommended: true,
    details: `detected=${detectedMarkers.join(' ') || 'none'}`
  });
  addButtonReactionVariant(variants, {
    id: 'r_buttons_conservative',
    path,
    texts,
    title: 'Reactions · button counters · conservative',
    likeMarkers: conservativeLikeMarkers,
    dislikeMarkers: conservativeDislikeMarkers,
    details: `likes=${conservativeLikeMarkers.join(' ') || 'none'}, dislikes=${conservativeDislikeMarkers.join(' ') || 'none'}`
  });
  addButtonReactionVariant(variants, {
    id: 'r_buttons_broad',
    path,
    texts,
    title: 'Reactions · button counters · broad',
    likeMarkers: broadLikeMarkers,
    dislikeMarkers: broadDislikeMarkers,
    details: `likes=${broadLikeMarkers.join(' ') || 'none'}, dislikes=${broadDislikeMarkers.join(' ') || 'none'}`
  });
  addButtonReactionVariant(variants, {
    id: 'r_buttons_except_negative',
    path,
    texts,
    title: 'Reactions · button counters · except 👎💩🤡 is like',
    likeMarkers: detectedMarkers.filter((marker) => !NEGATIVE_ONLY_EMOJIS.includes(marker) && marker !== '-' && marker !== '👎'),
    dislikeMarkers: detectedMarkers.filter((marker) => NEGATIVE_ONLY_EMOJIS.includes(marker) || marker === '-' || marker === '👎'),
    details: `likes=detected non-negative markers, dislikes=${NEGATIVE_ONLY_EMOJIS.join(' ')} -`
  });

  return dedupeButtonReactionVariants(variants);
}

function addButtonReactionVariant(variants, { id, path, texts, title, likeMarkers = [], dislikeMarkers = [], recommended = false, details = '' }) {
  const uniqueLikeMarkers = unique(likeMarkers);
  const uniqueDislikeMarkers = unique(dislikeMarkers);
  if (!uniqueLikeMarkers.length && !uniqueDislikeMarkers.length) return;
  variants.push({
    id,
    kind: 'reaction button',
    title,
    description: `path=${path}, ${details}, button texts=${texts.length}`,
    recommended,
    likesRules: uniqueLikeMarkers.length ? buildReactionRules(path, uniqueLikeMarkers) : [],
    dislikesRules: uniqueDislikeMarkers.length ? buildReactionRules(path, uniqueDislikeMarkers) : []
  });
}

function dedupeButtonReactionVariants(variants) {
  const seen = new Set();
  const result = [];
  for (const variant of variants) {
    const key = JSON.stringify({ likes: variant.likesRules, dislikes: variant.dislikesRules });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(variant);
  }
  return result;
}

function getDetectedReactionMarkers(texts = []) {
  const markerCandidates = unique([
    ...CONSERVATIVE_LIKE_EMOJIS,
    ...CONSERVATIVE_DISLIKE_EMOJIS,
    ...BROAD_LIKE_EMOJIS,
    ...BROAD_DISLIKE_EMOJIS,
    ...NEGATIVE_ONLY_EMOJIS,
    '+',
    '-'
  ]);
  return markerCandidates.filter((marker) => texts.some((text) => String(text).includes(marker)));
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
      title: 'Reactions · native · conservative',
      description: `${baseDescription}; likes=${CONSERVATIVE_LIKE_EMOJIS.join(' ')}, dislikes=${CONSERVATIVE_DISLIKE_EMOJIS.join(' ')}`,
      recommended: false,
      ...buildNativeReactionRules(path, {
        likeEmojis: CONSERVATIVE_LIKE_EMOJIS,
        dislikeEmojis: CONSERVATIVE_DISLIKE_EMOJIS
      })
    },
    {
      id: 'r_native_broad',
      kind: 'native reaction',
      title: 'Reactions · native · broad',
      description: `${baseDescription}; broad positive/negative emoji sets`,
      recommended: false,
      ...buildNativeReactionRules(path, {
        likeEmojis: BROAD_LIKE_EMOJIS,
        dislikeEmojis: BROAD_DISLIKE_EMOJIS
      })
    },
    {
      id: 'r_native_except_negative',
      kind: 'native reaction',
      title: 'Reactions · native · except 👎💩🤡 is like',
      description: `${baseDescription}; likes=all native emoji except ${NEGATIVE_ONLY_EMOJIS.join(' ')}, dislikes=${NEGATIVE_ONLY_EMOJIS.join(' ')}`,
      recommended: true,
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
      ['➡️ Next', [suggestion.afterApply || 'Run Test content or Preview to check the result.', 'Use Show last change for technical details.']]
    ]
  });
}

export function formatNoopSuggestion(suggestion) {
  return setupScreen({
    icon: '✓',
    title: 'No content rule changes',
    sections: [
      ['💡 Suggestion', [suggestion.title]],
      ['📌 State', ['This suggestion is already reflected in the current content draft.']],
      ['➡️ Next', ['Apply another • suggestion, or run Test content / Preview.']]
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
          ? 'Apply filter suggestions again from this screen, or run Test content / Preview.'
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
  return lines.length ? lines : ['- No content rule changes.'];
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
    title: 'Quick setup',
    sections: [
      ['🔎 Scan', [`Scanned ${scanned} recent source message(s).`, `Current filters matched ${matched}.`]],
      ['💡 Recommended setup and available options', suggestionLines],
      ['ℹ️ Legend', ['• changes the content draft.', '✓ already matches the current draft and does nothing when clicked.']],
      ['➡️ Next', ['Apply the recommended setup, or review Filters / Author / Reactions separately. Then run Test content and Preview before saving.']]
    ]
  });
}

export function parserSuggestionsKeyboard(suggestions) {
  const rows = [];
  const recommended = suggestions.find((suggestion) => suggestion.id === 'rec');
  if (recommended) rows.push([suggestionButton(recommended, { fullTitle: true })]);
  rows.push([button('Review filters', 'setup:filters_options'), button('Review author', 'setup:author_options')]);
  rows.push([button('Review reactions', 'setup:reaction_options')]);
  rows.push([button('Test content', 'setup:test'), button('Preview', 'setup:preview')]);
  rows.push([button('Load more messages', 'setup:load_more:suggest')]);
  rows.push([button('Technical diagnostics', 'setup:technical'), button('Show config', 'setup:parser_config')]);
  rows.push([button('Back', 'setup:parser')]);
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


export function getSuggestionCategory(suggestion) {
  const id = String(suggestion?.id || '');
  if (id === 'rec') return 'quick';
  if (id.startsWith('f_')) return 'filters';
  if (id.startsWith('a_')) return 'author';
  if (id.startsWith('r_')) return 'reactions';
  return 'other';
}

export function filterSuggestionsByCategory(suggestions = [], category) {
  return suggestions.filter((suggestion) => getSuggestionCategory(suggestion) === category);
}

export function formatSuggestionOptions({ title, icon, categoryTitle, suggestions, scanned, matched, next }) {
  const states = suggestions || [];
  const lines = states.length
    ? states.map((suggestion) => `- ${formatSuggestionStateMarker(suggestion)} ${suggestion.title}${suggestion.recommended ? ' · ★ suggested' : ''}: ${suggestion.description}${suggestion.actionable ? '' : ' — current / no change'}`)
    : ['- No options found for this sample.'];
  return setupScreen({
    icon,
    title,
    sections: [
      ['🔎 Sample', [`Scanned ${scanned} recent source message(s).`, `Current filters matched ${matched}.`]],
      [categoryTitle, lines],
      ['ℹ️ Legend', ['★ suggested = best guess from current sample.', '• can apply, ✓ already current.']],
      ['➡️ Next', [next || 'Choose an option, then run the related test and Preview.']]
    ]
  });
}

export function formatSuggestionStateMarker(suggestion) {
  return suggestion.actionable ? '•' : '✓';
}

export function suggestionOptionsKeyboard(suggestions, { back = 'setup:parser', extraRows = [], loadMoreTarget = '' } = {}) {
  const rows = [];
  for (let index = 0; index < suggestions.length; index += 2) {
    rows.push(suggestions.slice(index, index + 2).map((suggestion) => suggestionButton(suggestion)));
  }
  for (const row of extraRows) rows.push(row);
  if (loadMoreTarget) rows.push([button('Load more messages', `setup:load_more:${loadMoreTarget}`)]);
  rows.push([button('Show last change', 'setup:last_change')]);
  rows.push([button('Back', back), button('Content setup', 'setup:parser')]);
  return inlineKeyboard(rows);
}

export function detectAuthorEntities(message) {
  const result = { mentionName: false, username: false, mentionNameExample: '', usernameExample: '' };
  const text = String(message?.text || message?.message || '');
  for (const entity of getMessageEntities(message)) {
    const type = String(entity?._ || entity?.type || entity?.className || entity?.kind || '').toLowerCase();
    const offset = Number(entity?.offset ?? 0);
    const length = Number(entity?.length ?? 0);
    const slice = Number.isFinite(offset) && Number.isFinite(length) && length > 0 ? text.slice(offset, offset + length).trim() : '';
    const url = String(entity?.url || '');
    const hasUser = entity?.user || entity?.userId || entity?.user_id;
    if (type.includes('mentionname') || type.includes('text_mention') || hasUser || /^tg:\/\/user\?id=\d+/i.test(url)) {
      result.mentionName = true;
      if (!result.mentionNameExample && (slice || url)) result.mentionNameExample = slice || url;
    } else if (type.includes('mention') || /^@[A-Za-z0-9_]{5,32}$/.test(slice)) {
      result.username = true;
      if (!result.usernameExample && slice) result.usernameExample = slice;
    }
  }
  return result;
}

export function getMessageEntities(message) {
  const entities = [];
  if (Array.isArray(message?.entities)) entities.push(...message.entities);
  if (Array.isArray(message?.messageEntities)) entities.push(...message.messageEntities);
  if (Array.isArray(message?.raw?.entities)) entities.push(...message.raw.entities);
  return entities;
}

export function getAuthorLinePatterns() {
  return [
    { label: 'label line · multilingual', regex: new RegExp(AUTHOR_LABEL_REGEX, 'i'), ruleRegex: AUTHOR_LABEL_REGEX }
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

function unique(values) {
  return [...new Set((values || []).map((value) => String(value)).filter(Boolean))];
}
