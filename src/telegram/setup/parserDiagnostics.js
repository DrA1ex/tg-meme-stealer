import { getReactionCount, getReactionEmoji, parseMessagesToPosts } from '../../core/postParser.js';
import { setupScreen } from './formattingBase.js';
import {
  analyzeMessagesForParser,
  buildParserSuggestions,
  getSetupSenderId,
  getSetupValuesByPath,
  hasSetupContent,
  hasSetupMedia,
  markSuggestionStates,
  NATIVE_REACTION_PATHS,
  countNativeReactionEmojis
} from './parserSuggestions.js';

const TEXT_PATHS = ['text', 'message'];
const BUTTON_PATHS = ['markup.buttons[].text', 'replyMarkup.rows[].buttons[].text'];
const ENTITY_PATHS = ['entities[]', 'messageEntities[]'];

export function formatParserPaths(messages = [], draft = {}) {
  const stats = analyzeMessagesForParser(messages);
  const textLines = TEXT_PATHS.map((path) => {
    const count = countMessagesWithPath(messages, path);
    const authorCount = stats.authorLines.filter((item) => item.path === path).length;
    const marker = count ? '•' : '✓';
    const authorSuffix = authorCount ? `; author marker in ${authorCount}/${stats.scanned}` : '';
    return `- ${marker} message.${path}: ${count}/${stats.scanned} non-empty${authorSuffix}`;
  });

  const entityLines = ENTITY_PATHS.map((path) => {
    const values = messages.flatMap((message) => getSetupValuesByPath(message, path));
    const mentions = values.filter((entity) => String(entity?._ || entity?.type || entity?.className || '').toLowerCase().includes('mention') || String(entity?.url || '').startsWith('tg://user?id='));
    const examples = mentions.slice(0, 4).map((entity) => String(entity?._ || entity?.type || entity?.className || entity?.url || 'entity')).join(' · ') || 'none';
    const marker = mentions.length ? '•' : '✓';
    return `- ${marker} message.${path}: ${mentions.length} mention-like entities; examples: ${examples}`;
  });

  const buttonLines = BUTTON_PATHS.map((path) => {
    const labels = stats.buttonPaths.get(path) || [];
    const messageCount = countMessagesWithPath(messages, path);
    const examples = unique(labels).slice(0, 4).join(' · ') || 'none';
    const marker = labels.length ? '•' : '✓';
    return `- ${marker} message.${path}: ${messageCount}/${stats.scanned} messages, ${labels.length} labels; examples: ${examples}`;
  });

  const nativeReactionLines = NATIVE_REACTION_PATHS.map((path) => {
    const values = stats.nativeReactionPaths.get(path) || [];
    const messageCount = countMessagesWithNativeReactionPath(messages, path);
    const examples = countNativeReactionEmojis(values).slice(0, 6).map(([emoji, count]) => `${emoji}=${count}`).join(' · ') || 'none';
    const marker = values.length ? '•' : '✓';
    return `- ${marker} message.${path}: ${messageCount}/${stats.scanned} messages, ${values.length} reaction rows; examples: ${examples}`;
  });

  const recommendedTextPath = TEXT_PATHS
    .map((path) => ({ path, count: countMessagesWithPath(messages, path) }))
    .sort((a, b) => b.count - a.count)[0];
  const recommendedButtonPath = [...stats.buttonPaths.entries()]
    .map(([path, labels]) => ({ path, labels }))
    .sort((a, b) => b.labels.length - a.labels.length)[0];
  const recommendedNativeReactionPath = [...stats.nativeReactionPaths.entries()]
    .map(([path, values]) => ({ path, values }))
    .sort((a, b) => b.values.length - a.values.length)[0];

  return setupScreen({
    icon: '🧭',
    title: 'Parser paths',
    sections: [
      ['🔎 Scan', [`Scanned ${stats.scanned} recent source message(s).`]],
      ['📝 Text fields', textLines],
      ['👤 Author entity fields', entityLines],
      ['👍 Reaction button fields', buttonLines],
      ['🧡 Native reaction fields', nativeReactionLines],
      ['💡 Recommended', [
        recommendedTextPath?.count ? `Use message.${recommendedTextPath.path} for label-line author rules.` : 'No reliable text field detected.',
        recommendedButtonPath ? `Use message.${recommendedButtonPath.path} for reaction buttons.` : 'No reaction button path detected.',
        recommendedNativeReactionPath ? `Use message.${recommendedNativeReactionPath.path} for native reaction counters.` : 'No native reaction path detected.'
      ]],
      ['➡️ Next', ['Use Author / Reactions screens for normal setup; this screen is Diagnostics.']]
    ]
  });
}

export function formatAuthorExtractionTest({ messages = [], draft = {}, baseConfig = {} }) {
  const posts = parseDiagnosticPosts(messages, draft, baseConfig);
  const lines = posts.slice(0, 12).map((post) => {
    const author = post.author || 'unknown';
    const text = oneLine(post.text || '', 42);
    return `- #${post.messageId}: ${author}${text ? ` · ${text}` : ''}`;
  });
  const missing = posts.filter((post) => !post.author || post.author === 'unknown').length;

  return setupScreen({
    icon: '👤',
    title: 'Author test',
    sections: [
      ['🔎 Scan', [`Matched ${posts.length} post(s) from ${messages.length} scanned message(s).`, `Missing/unknown authors: ${missing}.`]],
      ['🧪 Extracted authors', lines.length ? lines : ['- No matched posts. Check filters first.']],
      ['➡️ Next', ['If authors look wrong, open Author options and choose another mode.']]
    ]
  });
}

export function formatReactionExtractionTest({ messages = [], draft = {}, baseConfig = {} }) {
  const posts = parseDiagnosticPosts(messages, draft, baseConfig);
  const zeroLikes = posts.filter((post) => Number(post.likes || 0) === 0).length;
  const lines = posts.slice(0, 12).map((post) => {
    const score = Number(post.likes || 0) + Number(post.dislikes || 0);
    return `- #${post.messageId}: 👍 ${post.likes || 0} 👎 ${post.dislikes || 0}, sum=${score}`;
  });
  const warnings = [];
  if (posts.length && zeroLikes / posts.length > 0.8) {
    const nativeRows = countNativeReactionRows(messages);
    warnings.push(nativeRows > 0
      ? `Reaction parser returns 0 likes for most matched posts, but ${nativeRows} native reaction row(s) were found. Try native reaction suggestions.`
      : 'Reaction parser returns 0 likes for most matched posts. Button path or regex may be wrong.');
  }

  return setupScreen({
    icon: '👍',
    title: 'Reaction test',
    sections: [
      ['🔎 Scan', [`Matched ${posts.length} post(s) from ${messages.length} scanned message(s).`, `Posts with 0 likes: ${zeroLikes}.`]],
      ['🧪 Extracted reactions', lines.length ? lines : ['- No matched posts. Check filters first.']],
      ...(warnings.length ? [['⚠️ Warnings', warnings.map((item) => `- ${item}`)]] : []),
      ['➡️ Next', ['If values look wrong, open Reaction options or Diagnostics.']]
    ]
  });
}

export function formatFilterImpact({ messages = [], draft = {}, baseConfig = {} }) {
  const currentPosts = parseDiagnosticPosts(messages, draft, baseConfig);
  const suggestions = markSuggestionStates(buildParserSuggestions(messages, draft), draft)
    .filter((suggestion) => suggestion.id.startsWith('f_'));
  const suggestionLines = suggestions.map((suggestion) => {
    const clone = structuredClone(draft || {});
    suggestion.apply(clone);
    const nextPosts = parseDiagnosticPosts(messages, clone, baseConfig);
    const delta = nextPosts.length - currentPosts.length;
    const deltaText = delta === 0 ? 'same' : delta > 0 ? `+${delta}` : String(delta);
    const marker = suggestion.actionable ? '•' : '✓';
    return `- ${marker} ${suggestion.title}: would match ${nextPosts.length}/${messages.length} (${deltaText})`;
  });

  const rejected = messages
    .filter((message) => parseDiagnosticPosts([message], draft, baseConfig).length === 0)
    .slice(0, 6)
    .map((message) => `- #${message?.id ?? '?'}: ${inferRejectionReason(message, draft)}`);

  return setupScreen({
    icon: '🧪',
    title: 'Filter impact',
    sections: [
      ['📌 Current filters', [`Current parser matches ${currentPosts.length}/${messages.length} recent message(s).`]],
      ['✨ Suggestion impact', suggestionLines.length ? suggestionLines : ['- No filter suggestions available.']],
      ['🚫 Rejected examples', rejected.length ? rejected : ['- none in this sample']],
      ['➡️ Next', ['Use Filter options to apply filters, then run Test content / Preview.']]
    ]
  });
}

function parseDiagnosticPosts(messages, draft, baseConfig) {
  return parseMessagesToPosts(messages, {
    chatId: baseConfig.telegram?.sourceChatId,
    parsing: draft.parsing || baseConfig.parsing || {}
  });
}

function countMessagesWithPath(messages, path) {
  return messages.filter((message) => getSetupValuesByPath(message, path).some((value) => String(value || '').trim())).length;
}

function inferRejectionReason(message, draft = {}) {
  const filters = Array.isArray(draft.parsing?.filters) ? draft.parsing.filters : [];
  if (!hasSetupContent(message)) return 'no text or supported media';
  if (filters.some((filter) => filter?.source === 'message' && filter?.transform === 'hasMedia') && !hasSetupMedia(message)) {
    return 'no photo/video media';
  }
  const senderFilter = filters.find((filter) => filter?.source === 'sender' && filter?.path === 'id' && ['equals', 'in'].includes(filter?.transform));
  if (senderFilter) {
    const expected = senderFilter.value ?? senderFilter.values;
    const current = getSetupSenderId(message) || 'unknown';
    return `sender mismatch: ${current} != ${Array.isArray(expected) ? expected.join(',') : expected}`;
  }
  return 'did not pass current parser filters';
}


function countMessagesWithNativeReactionPath(messages, path) {
  return messages.filter((message) => getSetupValuesByPath(message, path).some((value) => getReactionEmoji(value) && getReactionCount(value) > 0)).length;
}

function countNativeReactionRows(messages) {
  return NATIVE_REACTION_PATHS.reduce((sum, path) => (
    sum + messages.reduce((count, message) => (
      count + getSetupValuesByPath(message, path).filter((value) => getReactionEmoji(value) && getReactionCount(value) > 0).length
    ), 0)
  ), 0);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function oneLine(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}
