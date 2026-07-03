import { debugParseMessage, getReactionCount, getReactionEmoji, parseCount, parseMessagesToPosts } from '../../core/postParser.js';
import { escapeHtml } from '../../core/html.js';
import { setupHtmlScreen, setupScreen } from './formattingBase.js';
import {
  analyzeMessagesForParser,
  AUTHOR_LABEL_REGEX,
  countNativeReactionEmojis,
  formatReactionCountsForDisplay,
  formatReactionEmojiForSetup,
  detectAuthorEntities,
  formatSetupSenderLabel,
  getMessageEntities,
  getSetupMediaKind,
  getSetupSenderId,
  getSetupValuesByPath,
  hasSetupContent,
  hasSetupMedia,
  NATIVE_REACTION_PATHS
} from './parserSuggestions.js';

const BUTTON_PATHS = ['markup.buttons[].text', 'replyMarkup.rows[].buttons[].text'];
const TEXT_PATHS = ['text', 'message'];
const ENTITY_PATHS = ['entities[]', 'messageEntities[]'];
const MAX_PATH_DEPTH = 6;
const MAX_PATHS_PER_MESSAGE = 260;

export function formatTechnicalDiagnosticsOverview({ messages = [], draft = {}, baseConfig = {}, sample = {} } = {}) {
  const posts = parseDiagnosticPosts(messages, draft, baseConfig);
  const cacheAge = sample.cacheAgeMs === null || sample.cacheAgeMs === undefined
                   ? 'unknown'
                   : formatAge(sample.cacheAgeMs);

  return setupScreen({
    icon: '🛠',
    title: 'Technical diagnostics',
    sections: [
      ['📦 Loaded sample', [
        `Loaded: ${messages.length}/${sample.maxLimit || '?'} source message(s).`,
        `Current filters matched: ${posts.length}.`,
        `Rejected: ${Math.max(0, messages.length - posts.length)}.`,
        `Cache age: ${cacheAge}.`,
        sample.exhausted ? 'Source history ended for this sample.' : 'More source messages may be available.'
      ]],
      ['🔎 Diagnostics', [
        'Field scan: raw Telegram object paths and coverage.',
        'Message shape: media, buttons, entities, senders, forwards/replies.',
        'Reaction fields: button counters and native Telegram reactions.',
        'Author fields: label lines, mentions, sender fallback.',
        'Parser trace: why a concrete message matched or did not match.'
      ]],
      ['➡️ Next', ['Use these tools only when normal Filters / Author / Reactions screens do not explain enough.']]
    ]
  });
}

export function formatFieldScan(messages = []) {
  const fieldRows = scanFieldPaths(messages);
  const common = fieldRows
    .filter((row) => row.count > 0)
    .slice(0, 45)
    .map((row) => `- ${row.path} · ${row.count}/${messages.length}${row.examples.length ? ` · ${row.examples.join(' · ')}` : ''}`);

  const textPathLines = TEXT_PATHS.map((path) => `- ${path} · ${countMessagesWithPath(messages, path)}/${messages.length}`);
  const buttonPathLines = BUTTON_PATHS.map((path) => `- ${path} · ${countMessagesWithPath(messages, path)}/${messages.length}`);
  const nativePathLines = NATIVE_REACTION_PATHS.map((path) => `- ${path} · ${countMessagesWithNativeReactionPath(messages, path)}/${messages.length}`);

  return setupScreen({
    icon: '🧭',
    title: 'Field scan',
    sections: [
      ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
      ['📝 Known text paths', textPathLines],
      ['👍 Known reaction paths', [...buttonPathLines, ...nativePathLines]],
      ['🧬 Common raw paths', common.length ? common : ['- no fields found']],
      ['➡️ Next', ['Use Raw compact or Parser trace for a concrete message.']]
    ]
  });
}

export function formatMessageShape(messages = []) {
  const mediaKinds = countBy(messages.map(getSetupMediaKind));
  const topSenders = getTopSenders(messages).slice(0, 8).map((sender) => (
    `- ${sender.id || 'unknown'} · ${sender.count}/${messages.length}${sender.label ? ` · ${sender.label}` : ''}`
  ));
  const withButtons = messages.filter((message) => BUTTON_PATHS.some((path) => getSetupValuesByPath(message, path).length > 0)).length;
  const withNativeReactions = messages.filter((message) => NATIVE_REACTION_PATHS.some((path) => (
    getSetupValuesByPath(message, path).some((value) => getReactionEmoji(value) && getReactionCount(value) > 0)
  ))).length;
  const withEntities = messages.filter((message) => getMessageEntities(message).length > 0).length;

  return setupScreen({
    icon: '📊',
    title: 'Message shape',
    sections: [
      ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
      ['🧩 Content', [
        `With text/content: ${messages.filter(hasSetupContent).length}/${messages.length}.`,
        `With media: ${messages.filter(hasSetupMedia).length}/${messages.length}.`,
        `Photos: ${mediaKinds.photo || 0}.`,
        `Videos: ${mediaKinds.video || 0}.`,
        `Text-only: ${mediaKinds.text || 0}.`,
        `Albums/media groups: ${messages.filter((message) => message?.groupedId).length}.`,
        `Forwards: ${messages.filter(hasForwardInfo).length}.`,
        `Replies: ${messages.filter(hasReplyInfo).length}.`
      ]],
      ['👍 Interaction fields', [
        `With button counters: ${withButtons}/${messages.length}.`,
        `With native reactions: ${withNativeReactions}/${messages.length}.`,
        `With entities: ${withEntities}/${messages.length}.`
      ]],
      ['👤 Top senders', topSenders.length ? topSenders : ['- no sender data found']]
    ]
  });
}

export function formatReactionFields(messages = []) {
  const stats = analyzeMessagesForParser(messages);
  const buttonLines = BUTTON_PATHS.flatMap((path) => {
    const labels = stats.buttonPaths.get(path) || [];
    const messageCount = countMessagesWithPath(messages, path);
    const markerSummary = summarizeButtonReactionLabels(labels);
    return [
      `- ${path} · ${messageCount}/${messages.length} messages, ${labels.length} labels`,
      ...(markerSummary.length ? [`  ${markerSummary.join(' · ')}`] : [])
    ];
  });

  const nativeLines = NATIVE_REACTION_PATHS.flatMap((path) => {
    const values = stats.nativeReactionPaths.get(path) || [];
    const messageCount = countMessagesWithNativeReactionPath(messages, path);
    const emojiCountsText = formatReactionCountsForDisplay(countNativeReactionEmojis(values).slice(0, 12));
    return [
      `- ${path} · ${messageCount}/${messages.length} messages, ${values.length} reaction row(s)`,
      ...(emojiCountsText && emojiCountsText !== 'none' ? [`  ${emojiCountsText}`] : [])
    ];
  });

  return setupScreen({
    icon: '👍',
    title: 'Reaction fields',
    sections: [
      ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
      ['🔘 Button counters', buttonLines.length ? buttonLines : ['- no button counter fields found']],
      ['🧡 Native reactions', nativeLines.length ? nativeLines : ['- no native reaction fields found']],
      ['ℹ️ Legend', ['◆ = custom Telegram reaction/sticker emoji. Button counters are grouped by marker, not by full label text.']],
      ['➡️ Next', ['Open Reactions → Reaction options to choose one of the detected modes.']]
    ]
  });
}

export function formatAuthorFields(messages = []) {
  const stats = analyzeMessagesForParser(messages);
  const labelCounts = countAuthorLabelLines(messages);
  const labelLines = [...labelCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([path, data]) => `- ${path} · ${data.count}/${messages.length}${data.examples.length ? ` · ${data.examples.join(' · ')}` : ''}`);

  const mentionExamples = [...new Set(stats.mentionExamples)].slice(0, 6);
  const usernameExamples = [...new Set(stats.usernameExamples)].slice(0, 8);

  return setupScreen({
    icon: '👤',
    title: 'Author fields',
    sections: [
      ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
      ['🏷 Label lines', labelLines.length ? labelLines : ['- no multilingual label lines found']],
      ['🔗 Telegram mentions', [
        `mentionName / text_mention / tg://user?id: ${stats.mentionNameCount}/${messages.length}.`,
        mentionExamples.length ? `Examples: ${mentionExamples.join(' · ')}` : 'Examples: none.',
        `@username mentions: ${stats.usernameMentionCount}/${messages.length}.`,
        usernameExamples.length ? `Examples: ${usernameExamples.join(' · ')}` : 'Examples: none.'
      ]],
      ['👥 Sender fallback', [
        `sender.firstName: ${stats.senderNameCount}/${messages.length}.`,
        `sender.username: ${stats.senderUsernameCount}/${messages.length}.`,
        stats.topSender ? `Top sender: ${stats.topSender.id}${stats.topSender.label ? ` · ${stats.topSender.label}` : ''} · ${stats.topSender.count}/${messages.length}.` : 'Top sender: none.'
      ]],
      ['➡️ Next', ['Open Author → Author options to choose one of these extraction modes.']]
    ]
  });
}

export function formatParserTrace({ messages = [], draft = {}, baseConfig = {}, mode = 'matched', index = 0 } = {}) {
  const found = findDiagnosticMessage(messages, draft, baseConfig, mode, index);
  if (!found.message) {
    return setupScreen({
      icon: '🧪',
      title: `Parser trace · ${formatTraceMode(mode)}`,
      sections: [
        ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
        ['⚠️ Not found', [`No message matched trace mode: ${formatTraceMode(mode)}.`]],
        ['➡️ Next', ['Load more messages or choose another trace mode.']]
      ]
    });
  }

  const debug = debugParseMessage(found.message, {
    chatId: baseConfig.telegram?.sourceChatId,
    parsing: draft.parsing || baseConfig.parsing || {}
  });

  const filterLines = formatFilterTrace(debug.filters);
  const authorLines = formatExtractorTrace(debug.extractors?.author, 'author');
  const likesLines = formatNumberTrace(debug.extractors?.likes, 'likes');
  const dislikesLines = formatNumberTrace(debug.extractors?.dislikes, 'dislikes');
  const result = debug.result?.post || null;

  return setupScreen({
    icon: '🧪',
    title: `Parser trace · ${formatTraceMode(mode)}`,
    sections: [
      ['📌 Message', [
        `#${debug.messageId || found.message?.id || '?'}`,
        `Item: ${Number(found.index || 0) + 1}/${found.total || 1}`,
        `Reason: ${found.reason}`,
        `matched=${Boolean(debug.result?.matched)}`
      ]],
      ['🔎 Filters', filterLines],
      ['👤 Author', authorLines],
      ['👍 Likes', likesLines],
      ['👎 Dislikes', dislikesLines],
      ['✅ Result', result ? [
        `author=${result.author || 'unknown'}`,
        `likes=${result.likes || 0}, dislikes=${result.dislikes || 0}`,
        `text=${oneLine(result.text || '', 80) || '<empty>'}`
      ] : ['Message did not become a parsed post.']]
    ]
  });
}

export function formatCompactRawMessageScreen({ messages = [], draft = {}, baseConfig = {}, mode = 'matched', index = 0 } = {}) {
  const found = findDiagnosticMessage(messages, draft, baseConfig, mode, index);
  if (!found.message) {
    return setupHtmlScreen({
      icon: '🧬',
      title: `Raw compact · ${formatRawMode(mode)}`,
      sections: [
        ['📦 Sample', [`Scanned ${messages.length} loaded source message(s).`]],
        ['⚠️ Not found', [`No message matched raw mode: ${formatRawMode(mode)}.`]],
        ['➡️ Next', ['Load more messages or choose another raw mode.']]
      ]
    });
  }
  const compact = buildCompactRawMessage(found.message);
  const json = JSON.stringify(compact, null, 2);
  const clipped = json.length > 2800 ? `${json.slice(0, 2800)}
… <clipped>` : json;
  return setupHtmlScreen({
    icon: '🧬',
    title: `Raw compact · ${formatRawMode(mode)}`,
    sections: [
      ['📌 Message', [
        `#${found.message?.id || '?'}`,
        `Item: ${Number(found.index || 0) + 1}/${found.total || 1}`,
        `Reason: ${found.reason}`
      ]],
      ['🧾 Compact JSON', [htmlJsonBlock(clipped)]],
      ['➡️ Next', ['Use Next / Prev to inspect another matching message, or Message browser for manual selection.']]
    ]
  });
}


export function buildCompactRawMessage(message) {
  if (!message) return null;
  return pruneEmpty({
    id: message.id,
    date: message.date instanceof Date ? message.date.toISOString() : message.date,
    text: message.text,
    message: message.message,
    sender: compactSender(message.sender),
    senderId: message.senderId,
    fromId: message.fromId,
    groupedId: message.groupedId,
    mediaKind: getSetupMediaKind(message),
    media: compactMedia(message.media),
    markup: compactMarkup(message.markup),
    replyMarkup: compactMarkup(message.replyMarkup),
    reactions: compactReactions(message.nativeReactions || message.reactionCounts || message.messageReactions?.reactions || message.reactions || message.reactionCount),
    entities: compactEntities(getMessageEntities(message)),
    replyTo: message.replyTo || message.replyToMsgId || undefined,
    forward: message.forward || message.fwdFrom || undefined
  });
}

export function findDiagnosticMessage(messages = [], draft = {}, baseConfig = {}, mode = 'matched', index = 0) {
  const matches = findDiagnosticMessages(messages, draft, baseConfig, mode);
  const safeIndex = clampDiagnosticIndex(index, matches.length);
  return matches[safeIndex] || { message: null, post: null, reason: '', index: 0, total: 0 };
}

export function findDiagnosticMessages(messages = [], draft = {}, baseConfig = {}, mode = 'matched') {
  const parsingOptions = {
    chatId: baseConfig.telegram?.sourceChatId,
    parsing: draft.parsing || baseConfig.parsing || {}
  };
  const parsedById = new Map();
  const getPosts = (message) => {
    const key = String(message?.id ?? Math.random());
    if (!parsedById.has(key)) parsedById.set(key, parseMessagesToPosts([message], parsingOptions));
    return parsedById.get(key);
  };

  const matches = [];
  for (const message of messages) {
    const posts = getPosts(message);
    const firstPost = posts[0] || null;
    let reason = '';
    if (mode === 'matched' && firstPost) reason = 'parsed post in sample';
    if (mode === 'rejected' && !firstPost) reason = 'message rejected by current parser';
    if (mode === 'unknown_author' && firstPost && (!firstPost.author || firstPost.author === 'unknown')) reason = 'parsed post with missing/unknown author';
    if (mode === 'zero_likes' && firstPost && Number(firstPost.likes || 0) === 0) reason = 'parsed post with zero likes';
    if (mode === 'buttons' && BUTTON_PATHS.some((path) => getSetupValuesByPath(message, path).length > 0)) reason = 'message with reaction buttons';
    if (mode === 'native_reactions' && NATIVE_REACTION_PATHS.some((path) => getSetupValuesByPath(message, path).some((value) => getReactionEmoji(value)))) reason = 'message with native reactions';
    if (mode === 'mention' && getMessageEntities(message).some((entity) => String(entity?._ || entity?.type || entity?.className || entity?.url || '').toLowerCase().includes('mention') || String(entity?.url || '').startsWith('tg://user?id='))) reason = 'message with mention-like entity';
    if (reason) matches.push({ message, post: firstPost, reason, index: matches.length, total: 0 });
  }
  return matches.map((item) => ({ ...item, total: matches.length }));
}

export function clampDiagnosticIndex(index = 0, total = 0) {
  if (!total) return 0;
  const parsed = Number(index || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, parsed), total - 1);
}

function parseDiagnosticPosts(messages, draft, baseConfig) {
  return parseMessagesToPosts(messages, {
    chatId: baseConfig.telegram?.sourceChatId,
    parsing: draft.parsing || baseConfig.parsing || {}
  });
}


export function formatMessageBrowser({ messages = [], draft = {}, baseConfig = {}, page = 0, pageSize = 6 } = {}) {
  const parsed = parseDiagnosticPosts(messages, draft, baseConfig);
  const postByMessageId = new Map(parsed.map((post) => [Number(post.messageId), post]));
  const totalPages = Math.max(1, Math.ceil(messages.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page || 0)), totalPages - 1);
  const pageMessages = messages.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const lines = pageMessages.map((message) => {
    const id = Number(message?.id || 0);
    const post = postByMessageId.get(id);
    const date = formatMessageDate(message);
    const media = getSetupMediaKind(message);
    const text = oneLine(String(message?.message || message?.text || '').replace(/\n/g, ' '), 90) || '<no text>';
    return `- #${id || '?'} · ${post ? '✓ matched' : '✗ rejected'} · ${date} · ${media} · ${post ? `👍${post.likes || 0}/👎${post.dislikes || 0}` : 'not parsed'} · ${text}`;
  });
  return setupScreen({
    icon: '🔍',
    title: 'Message browser',
    sections: [
      ['📦 Sample', [`Loaded ${messages.length} message(s). Page ${currentPage + 1}/${totalPages}.`]],
      ['🧾 Messages', lines.length ? lines : ['- no loaded messages']],
      ['➡️ Next', ['Click a message id to inspect parser trace and compact fields. Use Load more to add more messages without changing draft config.']]
    ]
  });
}

export function formatTechnicalMessagePreview({ message = null, draft = {}, baseConfig = {} } = {}) {
  if (!message) {
    return setupScreen({
      icon: '🔍',
      title: 'Message preview',
      sections: [
        ['⚠️ Not found', ['Message is not available in the loaded setup sample.']],
        ['➡️ Next', ['Load more messages or refresh sample.']]
      ]
    });
  }
  const debug = debugParseMessage(message, {
    chatId: baseConfig.telegram?.sourceChatId,
    parsing: draft.parsing || baseConfig.parsing || {}
  });
  const compact = buildCompactRawMessage(message);
  return setupScreen({
    icon: '🔍',
    title: `Message preview · #${Number(message.id || 0) || '?'}`,
    sections: [
      ['📌 Summary', [
        `matched=${Boolean(debug.result?.matched)}`,
        `date=${formatMessageDate(message)}`,
        `media=${getSetupMediaKind(message)}`,
        `text=${oneLine(String(message?.message || message?.text || ''), 90) || '<no text>'}`
      ]],
      ['📝 Message text', [String(message?.message || message?.text || '').trim() || '<no text>']],
      ['✅ Parsed result', debug.result?.post ? [
        `author=${debug.result.post.author || 'unknown'}`,
        `likes=${debug.result.post.likes || 0}, dislikes=${debug.result.post.dislikes || 0}`
      ] : ['Message does not match current filters/parser.']],
      ['🔎 Filters', formatFilterTrace(debug.filters)],
      ['👤 Author', formatExtractorTrace(debug.extractors?.author, 'author')],
      ['👍 Likes', formatNumberTrace(debug.extractors?.likes, 'likes')],
      ['👎 Dislikes', formatNumberTrace(debug.extractors?.dislikes, 'dislikes')],
      ['🧬 Compact fields', [
        `sender=${JSON.stringify(compact.sender || {})}`,
        `buttons=${JSON.stringify(compact.markup?.buttons || compact.markup?.rows || compact.replyMarkup?.buttons || compact.replyMarkup?.rows || [])}`,
        `nativeReactions=${JSON.stringify(compact.nativeReactions || compact.reactionCounts || compact.messageReactions || [])}`,
        `entities=${JSON.stringify(compact.entities || compact.messageEntities || [])}`
      ]]
    ]
  });
}

function formatRawMode(mode) {
  const labels = {
    matched: 'matched',
    rejected: 'rejected',
    buttons: 'reactions/buttons',
    native_reactions: 'native reactions',
    mention: 'mention'
  };
  return labels[mode] || String(mode || 'matched');
}

function formatMessageDate(message) {
  const date = message?.date instanceof Date ? message.date : new Date(Number(message?.date || 0) * 1000);
  return Number.isNaN(date.getTime()) ? '<no date>' : date.toISOString().slice(0, 16).replace('T', ' ');
}

function scanFieldPaths(messages) {
  const counts = new Map();
  const examples = new Map();
  for (const message of messages) {
    const paths = new Map();
    collectFieldPaths(message, '', paths, { depth: 0, seen: 0 });
    for (const [path, sample] of paths.entries()) {
      counts.set(path, (counts.get(path) || 0) + 1);
      if (sample && (!examples.has(path) || examples.get(path).length < 2)) {
        const current = examples.get(path) || [];
        current.push(sample);
        examples.set(path, current);
      }
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count, examples: examples.get(path) || [] }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

function collectFieldPaths(value, path, output, state) {
  if (state.seen++ > MAX_PATHS_PER_MESSAGE) return;
  if (!path) path = '<root>';
  if (value === undefined || value === null) return;

  const type = Array.isArray(value) ? 'array' : typeof value;
  if (path !== '<root>') output.set(path, sampleValue(value));
  if (state.depth >= MAX_PATH_DEPTH) return;

  if (Array.isArray(value)) {
    const arrayPath = path.endsWith('[]') ? path : `${path}[]`;
    output.set(arrayPath, `${value.length} item(s)`);
    for (const item of value.slice(0, 3)) collectFieldPaths(item, arrayPath, output, { depth: state.depth + 1, seen: state.seen });
    return;
  }

  if (type === 'object') {
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      if (typeof child === 'function') continue;
      const childPath = path === '<root>' ? key : `${path}.${key}`;
      collectFieldPaths(child, childPath, output, { depth: state.depth + 1, seen: state.seen });
    }
  }
}

function countMessagesWithPath(messages, path) {
  return messages.filter((message) => getSetupValuesByPath(message, path).some((value) => String(value || '').trim())).length;
}

function countMessagesWithNativeReactionPath(messages, path) {
  return messages.filter((message) => getSetupValuesByPath(message, path).some((value) => getReactionEmoji(value) && getReactionCount(value) > 0)).length;
}

function countAuthorLabelLines(messages) {
  const result = new Map();
  const regex = new RegExp(AUTHOR_LABEL_REGEX, 'i');
  for (const message of messages) {
    for (const path of TEXT_PATHS) {
      const value = String(message?.[path] || '');
      const match = value.match(regex);
      if (!match) continue;
      const current = result.get(path) || { count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(oneLine(match[0].trim(), 28));
      result.set(path, current);
    }
  }
  return result;
}

function getTopSenders(messages) {
  const counts = new Map();
  const labels = new Map();
  for (const message of messages) {
    const id = getSetupSenderId(message) || 'unknown';
    counts.set(id, (counts.get(id) || 0) + 1);
    const label = formatSetupSenderLabel(message?.sender);
    if (label) labels.set(id, label);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count, label: labels.get(id) || '' }))
    .sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));
}

function formatFilterTrace(filters) {
  const rules = filters?.rules || [];
  if (!rules.length) return ['No filter rules configured; message passes by default.'];
  return rules.slice(0, 8).map((rule) => (
    `${rule.passed ? '✓' : '✗'} rule ${rule.index + 1}: ${compactRule(rule.rule)} · values=${rule.valuesCount} · ${rule.negated ? 'negated, ' : ''}${rule.passed ? 'passed' : 'failed'}`
  ));
}

function formatExtractorTrace(trace, label) {
  const rules = trace?.rules || [];
  if (!rules.length) return [`No ${label} rules configured.`];
  const lines = [];
  for (const rule of rules.slice(0, 6)) {
    lines.push(`${rule.accepted ? '✓' : '✗'} rule ${rule.index + 1}: ${compactRule(rule.rule)} · values=${rule.valuesCount}`);
    const accepted = rule.values?.find((value) => value.transformed !== undefined && value.transformed !== null && value.transformed !== '');
    if (accepted) lines.push(`  → ${accepted.transformed}`);
  }
  if (trace.selected !== undefined && trace.selected !== '') lines.push(`Selected: ${trace.selected}`);
  return lines;
}

function formatNumberTrace(trace, label) {
  const rules = trace?.rules || [];
  if (!rules.length) return [`No ${label} rules configured; fallback=${trace?.fallback ?? 0}.`];
  const lines = [];
  for (const rule of rules.slice(0, 6)) {
    lines.push(`${rule.acceptedValues?.length ? '✓' : '✗'} rule ${rule.index + 1}: ${compactRule(rule.rule)} · values=${rule.valuesCount} · subtotal=${rule.subtotal || 0}`);
  }
  lines.push(`Selected: ${trace?.selected ?? 0}${trace?.fallbackUsed ? ' · fallback used' : ''}`);
  return lines;
}

function compactRule(rule = {}) {
  const parts = [];
  if (rule.source) parts.push(rule.source);
  if (rule.path) parts.push(rule.path);
  if (rule.transform) parts.push(`transform=${rule.transform}`);
  if (rule.value !== undefined) parts.push(`value=${JSON.stringify(rule.value)}`);
  if (Array.isArray(rule.values)) parts.push(`values=${JSON.stringify(rule.values)}`);
  if (Array.isArray(rule.emojis)) parts.push(`emojis=${rule.emojis.join('')}`);
  if (rule.invert) parts.push('invert=true');
  if (rule.regex) parts.push(`regex=${JSON.stringify(oneLine(rule.regex, 32))}`);
  return parts.join(' · ') || JSON.stringify(rule);
}

function htmlJsonBlock(value) {
  return `<pre><code class="language-json">${escapeHtml(String(value || ''))}</code></pre>`;
}

function formatTraceMode(mode) {
  return String(mode || 'matched').replace(/_/g, ' ');
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}


function summarizeButtonReactionLabels(labels = []) {
  const markers = ['👍', '👎', '❤', '❤️', '🔥', '😂', '😁', '😍', '🥰', '👏', '🎉', '💩', '🤡', '🤮', '😡', '😢', '😭', '+', '-'];
  const stats = new Map();
  for (const label of labels || []) {
    const text = String(label || '');
    for (const marker of markers) {
      if (!text.includes(marker)) continue;
      const current = stats.get(marker) || { labels: 0, total: 0 };
      current.labels += 1;
      current.total += parseCount(text);
      stats.set(marker, current);
    }
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].labels - a[1].labels || b[1].total - a[1].total)
    .slice(0, 8)
    .map(([marker, value]) => `${marker}: ${value.labels} label(s), total ${value.total}`);
}

function topValues(values = []) {
  const counts = new Map();
  for (const value of values.map((item) => String(item || '').trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function hasForwardInfo(message) {
  return Boolean(message?.forward || message?.fwdFrom || message?.forwardInfo);
}

function hasReplyInfo(message) {
  return Boolean(message?.replyTo || message?.replyToMsgId || message?.replyToMessage || message?.replyToMessageId);
}

function sampleValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return '';
  return oneLine(String(value), 22);
}

function compactSender(sender) {
  if (!sender) return undefined;
  return pruneEmpty({
    id: sender.id?.value ?? sender.id,
    firstName: sender.firstName,
    lastName: sender.lastName,
    username: sender.username
  });
}

function compactMedia(media) {
  if (!media) return undefined;
  return pruneEmpty({
    type: media.type,
    className: media.className,
    mimeType: media.mimeType || media.document?.mimeType,
    photo: Boolean(media.photo),
    document: Boolean(media.document)
  });
}

function compactMarkup(markup) {
  if (!markup) return undefined;
  return pruneEmpty({
    buttons: getSetupValuesByPath({ markup }, 'markup.buttons[].text').slice(0, 20),
    rows: getSetupValuesByPath({ replyMarkup: markup }, 'replyMarkup.rows[].buttons[].text').slice(0, 20)
  });
}

function compactReactions(reactions) {
  if (!reactions) return undefined;
  if (Array.isArray(reactions)) return reactions.slice(0, 20).map(compactReactionRow);
  if (Array.isArray(reactions.results)) return { results: reactions.results.slice(0, 20).map(compactReactionRow) };
  return reactions;
}

function compactReactionRow(row) {
  return pruneEmpty({
    emoji: formatReactionEmojiForSetup(getReactionEmoji(row)),
    count: getReactionCount(row),
    rawType: row?._ || row?.type || row?.className
  });
}

function compactEntities(entities = []) {
  return entities.slice(0, 20).map((entity) => pruneEmpty({
    type: entity?._ || entity?.type || entity?.className,
    offset: entity?.offset,
    length: entity?.length,
    url: entity?.url,
    userId: entity?.userId || entity?.user_id || entity?.user?.id
  }));
}

function pruneEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || child === null || child === '') continue;
    if (Array.isArray(child) && child.length === 0) continue;
    if (typeof child === 'object' && !Array.isArray(child)) {
      const pruned = pruneEmpty(child);
      if (Object.keys(pruned || {}).length === 0) continue;
      result[key] = pruned;
    } else {
      result[key] = child;
    }
  }
  return result;
}

function formatAge(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function oneLine(value, maxLength = 80) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}
