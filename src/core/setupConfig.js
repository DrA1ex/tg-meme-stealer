import { formatPostCaption } from './format.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepMerge, validateConfig } from '../config/index.js';

const PARSING_KEYS = new Set(['filters', 'author', 'likes', 'dislikes']);

export function createSetupDraft(config) {
  return {
    parsing: structuredClone(config.parsing || {}),
    publish: structuredClone(config.publish || {}),
    templates: structuredClone(config.templates || {})
  };
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
    parsing: draft.parsing,
    publish: draft.publish,
    templates: draft.templates
  };
}

export function formatDraftConfig(draft) {
  return JSON.stringify(buildDraftConfig(draft), null, 2);
}

export async function saveDraftConfig(draft, configPath = 'config.json') {
  const resolvedPath = path.resolve(configPath);
  const directory = path.dirname(resolvedPath);
  const latestBackupPath = `${resolvedPath}.old`;
  const timestampBackupPath = `${resolvedPath}.${backupTimestamp()}.bak`;
  const temporaryPath = path.join(directory, `.${path.basename(resolvedPath)}.${process.pid}.${randomCode()}.tmp`);
  const existingConfig = await readJsonIfExists(resolvedPath);
  const nextConfig = deepMerge(existingConfig, buildDraftConfig(draft));
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  JSON.parse(serialized);
  await fs.mkdir(directory, { recursive: true });

  let handle;
  let hadExistingConfig = false;
  try {
    try {
      await fs.copyFile(resolvedPath, timestampBackupPath, fs.constants.COPYFILE_EXCL);
      await fs.copyFile(resolvedPath, latestBackupPath);
      hadExistingConfig = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, resolvedPath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    configPath: resolvedPath,
    backupPath: hadExistingConfig ? timestampBackupPath : null,
    latestBackupPath: hadExistingConfig ? latestBackupPath : null
  };
}

export function validateSetupDraft(draft, baseConfig) {
  validateConfig(deepMerge(baseConfig, buildDraftConfig(draft)), { pauseOnDuplicatePublishTemplates: false });
  return draft;
}

export function summarizeParsedPosts({ posts, scanned }, options = {}) {
  const maxRows = options.maxRows || posts.length;
  const rows = [['#', 'id', 'author', 'likes', 'dislikes', 'media', 'text']];

  for (let index = 0; index < Math.min(posts.length, maxRows); index += 1) {
    const post = posts[index];
    const media = post.data?.media?.map((item) => item.mediaKind).join(', ') || 'text';
    rows.push([
      index + 1,
      post.messageId,
      formatCell(post.author || 'missing', 18),
      post.likes ?? 0,
      post.dislikes ?? 0,
      formatCell(media, 12),
      formatCell(post.text || '', 32)
    ]);
  }

  return [
    `Scanned messages: ${scanned}`,
    `Matched posts: ${posts.length}`,
    `Shown rows: ${Math.min(posts.length, maxRows)}`,
    '',
    formatPaddedTable(rows)
  ].join('\n');
}

export function formatPaddedTable(rows) {
  const stringRows = rows.map((row) => row.map((cell) => String(cell)));
  const widths = stringRows[0].map((_, columnIndex) => (
    Math.max(...stringRows.map((row) => visibleLength(row[columnIndex] || '')))
  ));

  return stringRows
    .map((row) => row.map((cell, columnIndex) => ` ${padRight(cell, widths[columnIndex])} `).join('|'))
    .join('\n');
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
  const publishTemplate = parsePublishTemplateKey(key);
  if (publishTemplate) {
    setPublishTemplateField(draft, publishTemplate.key, publishTemplate.field, value);
    return draft;
  }

  const path = templatePathForKey(key);
  let target = draft.templates;
  for (const part of path.slice(0, -1)) {
    target[part] = target[part] || {};
    target = target[part];
  }
  target[path[path.length - 1]] = key === 'templates.publish.maxTextLength' ? Number(value) : String(value);
  return draft;
}

export function setPublishSources(draft, sources) {
  if (!Array.isArray(sources)) throw new Error('Publish sources must be a JSON array');
  draft.publish = draft.publish || {};
  draft.publish.sources = sources.map(assertPublishSource);
  return draft;
}

export function upsertPublishSource(draft, source) {
  const nextSource = assertPublishSource(source);
  draft.publish = draft.publish || {};
  draft.publish.sources = Array.isArray(draft.publish.sources) ? draft.publish.sources : [];
  const index = draft.publish.sources.findIndex((item) => item.key === nextSource.key);
  if (index >= 0) {
    draft.publish.sources[index] = { ...draft.publish.sources[index], ...nextSource };
  } else {
    draft.publish.sources.push(nextSource);
  }
  return draft;
}

export function setPublishTemplate(draft, template) {
  assertPlainObject(template, 'Publish template must be a JSON object');
  if (!template.key || typeof template.key !== 'string') {
    throw new Error('Publish template must have a string key');
  }

  draft.publish = draft.publish || {};
  draft.publish.template = Array.isArray(draft.publish.template) ? draft.publish.template : [];
  const index = draft.publish.template.findIndex((item) => item.key === template.key);
  if (index >= 0) {
    draft.publish.template[index] = deepMerge(draft.publish.template[index], template);
  } else {
    draft.publish.template.push(structuredClone(template));
  }
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
    'templates.publish.postCaption': ['publish', 'postCaption'],
    'templates.publish.unknownAuthor': ['publish', 'unknownAuthor'],
    'templates.publish.maxTextLength': ['publish', 'maxTextLength'],
    'templates.stats.summary': ['stats', 'summary'],
    'templates.stats.topPost': ['stats', 'topPost']
  };
  if (!paths[key]) {
    throw new Error(`Unknown template key: ${key}`);
  }
  return paths[key];
}

function parsePublishTemplateKey(key) {
  const match = /^publish\.template\.([^.]+)\.([^.]+)$/.exec(key);
  if (!match) return null;
  return { key: match[1], field: match[2] };
}

function setPublishTemplateField(draft, key, field, value) {
  if (field !== 'template') {
    throw new Error(`Unknown publish template field: ${field}`);
  }
  setPublishTemplate(draft, { key, template: String(value) });
}

function assertPublishSource(source) {
  assertPlainObject(source, 'Publish source must be a JSON object');
  if (!source.key || typeof source.key !== 'string') {
    throw new Error('Publish source must have a string key');
  }
  if (source.where !== undefined && typeof source.where !== 'string') {
    throw new Error('Publish source where must be a string');
  }
  return structuredClone(source);
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function formatCell(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return 'missing';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function padRight(value, width) {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${' '.repeat(padding)}`;
}

function visibleLength(value) {
  return String(value).length;
}

function formatPreviewMediaSummary(post) {
  const media = post.data?.media || [];
  if (!media.length) return 'Media: none';

  const ids = media.map((item) => `${item.mediaKind || 'media'}#${item.messageId || 'unknown'}`).join(', ');
  return `Media: ${media.length} item(s): ${ids}`;
}

function backupTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function randomCode() {
  return Math.random().toString(36).slice(2, 10);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is not supported on every platform. The file rename is still atomic.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
