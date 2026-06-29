import { formatPostCaption } from './format.js';

const PARSING_KEYS = new Set(['filters', 'author', 'likes', 'dislikes']);

export function createSetupDraft(config) {
  return {
    sync: {
      source: structuredClone(config.sync?.source || { mode: 'user' })
    },
    parsing: structuredClone(config.parsing || {})
  };
}

export function setSourceMode(draft, mode) {
  if (!['user', 'all'].includes(mode)) {
    throw new Error('Mode must be "user" or "all"');
  }
  draft.sync.source.mode = mode;
  return draft;
}

export function setParsingRules(draft, key, rules) {
  assertParsingKey(key);
  draft.parsing[key] = normalizeRules(rules);
  return draft;
}

export function addParsingRule(draft, key, rule) {
  assertParsingKey(key);
  draft.parsing[key] = [...normalizeRules(draft.parsing[key] || []), ...normalizeRules(rule)];
  return draft;
}

export function parseJsonArgument(text) {
  const argument = text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  if (!argument) throw new Error('JSON argument is required');
  return JSON.parse(argument);
}

export function buildDraftConfig(draft) {
  return {
    sync: {
      source: draft.sync.source
    },
    parsing: draft.parsing
  };
}

export function formatDraftConfig(draft) {
  return JSON.stringify(buildDraftConfig(draft), null, 2);
}

export function summarizeParsedPosts({ posts, scanned }) {
  const lines = [
    `Scanned messages: ${scanned}`,
    `Matched posts: ${posts.length}`
  ];

  for (const post of posts.slice(0, 5)) {
    const media = post.data?.media?.map((item) => item.mediaKind).join(', ') || 'text';
    lines.push(`#${post.messageId}: ${post.author || 'author?'} | 👍 ${post.likes} 👎 ${post.dislikes} | ${media}`);
  }

  return lines.join('\n');
}

export function selectWeekPreviewPost(posts, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return posts
    .filter((post) => new Date(post.messageDate) >= weekAgo)
    .sort((a, b) => b.likes - b.dislikes - (a.likes - a.dislikes) || b.likes - a.likes)[0] || null;
}

export function formatPreviewPost(post, templates = {}) {
  if (!post) return 'No matching posts found for the last week.';
  return formatPostCaption(post, 0, templates);
}

function normalizeRules(rules) {
  return Array.isArray(rules) ? rules : [rules];
}

function assertParsingKey(key) {
  if (!PARSING_KEYS.has(key)) {
    throw new Error(`Unknown parsing key: ${key}`);
  }
}
