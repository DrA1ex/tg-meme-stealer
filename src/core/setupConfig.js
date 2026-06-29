import { formatPostCaption } from './format.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepMerge } from '../config/index.js';

const PARSING_KEYS = new Set(['filters', 'author', 'likes', 'dislikes']);

export function createSetupDraft(config) {
  return {
    sync: {
      source: structuredClone(config.sync?.source || { mode: 'user' })
    },
    parsing: structuredClone(config.parsing || {}),
    templates: structuredClone(config.templates || {})
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
    parsing: draft.parsing,
    templates: draft.templates
  };
}

export function formatDraftConfig(draft) {
  return JSON.stringify(buildDraftConfig(draft), null, 2);
}

export async function saveDraftConfig(draft, configPath = 'config.json') {
  const resolvedPath = path.resolve(configPath);
  const backupPath = `${resolvedPath}.old`;
  const existingConfig = await readJsonIfExists(resolvedPath);
  const nextConfig = deepMerge(existingConfig, buildDraftConfig(draft));

  try {
    await fs.copyFile(resolvedPath, backupPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.writeFile(resolvedPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return { configPath: resolvedPath, backupPath };
}

export function summarizeParsedPosts({ posts, scanned }, options = {}) {
  const maxRows = options.maxRows || posts.length;
  const lines = [
    `Scanned messages: ${scanned}`,
    `Matched posts: ${posts.length}`,
    `Shown rows: ${Math.min(posts.length, maxRows)}`,
    '',
    ['#', 'id', 'author', 'likes', 'dislikes', 'media', 'text'].join(' | '),
    ['-', '--', '------', '-----', '--------', '-----', '----'].join(' | ')
  ];

  for (let index = 0; index < Math.min(posts.length, maxRows); index += 1) {
    const post = posts[index];
    const media = post.data?.media?.map((item) => item.mediaKind).join(', ') || 'text';
    lines.push([
      index + 1,
      post.messageId,
      formatCell(post.author || 'missing', 18),
      post.likes ?? 0,
      post.dislikes ?? 0,
      formatCell(media, 12),
      formatCell(post.text || '', 32)
    ].join(' | '));
  }

  return lines.join('\n');
}

export function selectWeekPreviewPost(posts, now = new Date()) {
  return selectWeekPreviewPosts(posts, 1, now)[0] || null;
}

export function selectWeekPreviewPosts(posts, limit = 1, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return posts
    .filter((post) => new Date(post.messageDate) >= weekAgo)
    .sort((a, b) => b.likes - b.dislikes - (a.likes - a.dislikes) || b.likes - a.likes)
    .slice(0, limit);
}

export function formatPreviewPost(post, templates = {}) {
  if (!post) return 'No matching posts found for the last week.';
  return [
    formatPostCaption(post, 0, templates),
    '',
    formatPreviewMediaSummary(post)
  ].join('\n');
}

export function setTemplateValue(draft, key, value) {
  const path = templatePathForKey(key);
  let target = draft.templates;
  for (const part of path.slice(0, -1)) {
    target[part] = target[part] || {};
    target = target[part];
  }
  target[path[path.length - 1]] = key === 'maxTextLength' ? Number(value) : String(value);
  return draft;
}

function normalizeRules(rules) {
  return Array.isArray(rules) ? rules : [rules];
}

function assertParsingKey(key) {
  if (!PARSING_KEYS.has(key)) {
    throw new Error(`Unknown parsing key: ${key}`);
  }
}

function templatePathForKey(key) {
  const paths = {
    postCaption: ['publish', 'postCaption'],
    unknownAuthor: ['publish', 'unknownAuthor'],
    maxTextLength: ['publish', 'maxTextLength'],
    'title.month': ['publish', 'selectionTitles', 'month'],
    'title.week': ['publish', 'selectionTitles', 'week'],
    'title.fresh': ['publish', 'selectionTitles', 'fresh'],
    'stats.summary': ['stats', 'summary'],
    'stats.topPost': ['stats', 'topPost']
  };
  if (!paths[key]) {
    throw new Error(`Unknown template key: ${key}`);
  }
  return paths[key];
}

function formatCell(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return 'missing';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatPreviewMediaSummary(post) {
  const media = post.data?.media || [];
  if (!media.length) return 'Media: none';

  const ids = media.map((item) => `${item.mediaKind || 'media'}#${item.messageId || 'unknown'}`).join(', ');
  return `Media: ${media.length} item(s): ${ids}`;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
