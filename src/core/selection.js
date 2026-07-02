import { subtractHours } from './date.js';
import { renderTemplate } from './format.js';

const SOURCES = ['best', 'controversial'];

export function buildSelectionSpecs(config, now = new Date(), keys = null, options = {}) {
  const chatId = config.telegram.sourceChatId;
  const templates = getPublishTemplates(config);
  const requestedKeys = keys ? new Set(normalizeSelectionKeys(keys, config)) : null;
  const specs = [];

  for (const entry of templates) {
    if (!entry?.enabled && !options.includeDisabled) continue;

    const publicKey = getSelectionKey(entry);
    if (requestedKeys && !requestedKeys.has(publicKey)) continue;

    const posts = normalizePosts(entry.posts, entry.limit);
    const reactions = normalizeReactions(entry.reactions);
    const windowHours = Number(entry.windowHours ?? 24);
    const until = new Date(now);
    const since = subtractHours(until, windowHours);

    specs.push({
      key: publicKey,
      source: entry.source,
      type: entry.source,
      templateKey: entry.key,
      period: entry.key,
      chatId,
      sinceIso: since.toISOString(),
      untilIso: until.toISOString(),
      scheduledAtIso: until.toISOString(),
      windowHours,
      limit: posts.max,
      posts,
      reactions,
      template: entry.template
    });
  }

  return specs;
}

export function getScheduledPublishEntries(config) {
  const entries = [];
  for (const entry of getPublishTemplates(config)) {
    if (entry?.enabled && entry.schedule) {
      entries.push({
        key: getSelectionKey(entry),
        type: entry.source,
        source: entry.source,
        templateKey: entry.key,
        period: entry.key,
        schedule: entry.schedule
      });
    }
  }
  return entries;
}

export function normalizeSelectionKeys(keys, config = null) {
  const values = Array.isArray(keys) ? keys : [keys];
  return values.flatMap((key) => normalizeSelectionKey(key, config)).filter(Boolean);
}

export async function loadSelections(repository, config, now = new Date(), keys = null) {
  const specs = buildSelectionSpecs(config, now, keys);
  const selections = [];

  for (const spec of specs) {
    selections.push(await loadSelection(repository, spec));
  }

  return selections;
}

export async function loadSelection(repository, spec) {
  const candidates = spec.type === 'controversial'
    ? await repository.getControversialPosts(spec)
    : await repository.getTopPosts(spec);
  const posts = selectPosts(candidates, spec);
  return {
    ...spec,
    title: renderSelectionTemplate(spec, posts),
    posts
  };
}

export function selectPosts(candidates, spec) {
  const posts = Array.isArray(candidates) ? candidates : [];
  const max = Math.max(0, Number(spec.posts?.max ?? spec.limit ?? posts.length));
  const target = Math.min(max, Math.max(0, Number(spec.posts?.target ?? max)));
  const min = Math.min(max, Math.max(0, Number(spec.posts?.min ?? target)));
  const reactionMin = Number(spec.reactions?.min ?? 0);
  const includeAbove = Number(spec.reactions?.includeAbove ?? Number.POSITIVE_INFINITY);
  const scored = posts.map((post) => ({
    post,
    score: getReactionScore(post, spec.reactions?.strategy || 'likes')
  }));

  const passing = scored.filter((item) => item.score >= reactionMin);
  let count = Math.min(max, target);

  const includeCount = passing.filter((item) => item.score >= includeAbove).length;
  count = Math.min(max, Math.max(count, includeCount));

  const selected = [];
  const seen = new Set();
  for (const item of passing.slice(0, count)) {
    selected.push(item.post);
    seen.add(getPostIdentity(item.post));
  }

  if (selected.length < min) {
    for (const item of scored) {
      if (selected.length >= min) break;
      const identity = getPostIdentity(item.post);
      if (seen.has(identity)) continue;
      selected.push(item.post);
      seen.add(identity);
    }
  }

  return selected.slice(0, max);
}

function normalizeSelectionKey(key, config) {
  if (key === undefined || key === null || key === '') return [];
  const value = String(key);
  const templates = getPublishTemplates(config || {});

  if (value === 'fresh') return normalizeSelectionKey('day', config);

  if (SOURCES.map((source) => `${source}.*`).includes(value)) {
    const source = value.slice(0, -2);
    return templates
      .filter((template) => template.source === source)
      .map((template) => getSelectionKey(template));
  }

  if (SOURCES.includes(value)) return normalizeSelectionKey(`${value}.*`, config);

  if (/^(best|controversial)\.[^.]+$/.test(value)) {
    if (!config) return [value];
    const [source, key] = value.split('.');
    if (templates.some((template) => template.source === source && template.key === key)) return [value];
  }

  const exact = templates.find((template) => template.key === value);
  if (exact) return [getSelectionKey(exact)];

  throw new Error(`Unknown publish selection: ${value}. Expected a template key, source.key, best.*, or controversial.*.`);
}

function getPublishTemplates(config) {
  return Array.isArray(config?.publish?.template) ? config.publish.template : [];
}

function getSelectionKey(entry) {
  return `${entry.source}.${entry.key}`;
}

function normalizePosts(posts = {}, legacyLimit = undefined) {
  const max = Number(posts.max ?? posts.target ?? legacyLimit ?? 10);
  const target = Number(posts.target ?? max);
  const min = Number(posts.min ?? target);
  return { min, target, max };
}

function normalizeReactions(reactions = {}) {
  return {
    strategy: reactions.strategy || 'likes',
    min: Number(reactions.min ?? 0),
    includeAbove: Number(reactions.includeAbove ?? Number.POSITIVE_INFINITY)
  };
}

function getReactionScore(post, strategy) {
  const likes = Number(post.likes || 0);
  const dislikes = Number(post.dislikes || 0);
  if (strategy === 'dislikes') return dislikes;
  if (strategy === 'sum') return likes + dislikes;
  if (strategy === 'max') return Math.max(likes, dislikes);
  return likes;
}

function getPostIdentity(post) {
  return `${post.chatId || ''}:${post.messageId || ''}`;
}

export function renderSelectionTemplate(spec, posts) {
  return renderTemplate(spec.template || spec.key, {
    key: spec.key,
    source: spec.source,
    type: spec.type,
    templateKey: spec.templateKey,
    period: spec.period,
    count: posts.length,
    limit: spec.limit,
    posts: spec.posts,
    reactions: spec.reactions,
    windowHours: spec.windowHours || hoursBetween(spec.sinceIso, spec.untilIso)
  }).trim();
}

function hoursBetween(sinceIso, untilIso) {
  return Math.round((new Date(untilIso).getTime() - new Date(sinceIso).getTime()) / 60 / 60 / 1000);
}
