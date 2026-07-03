import { subtractHours } from './date.js';
import { renderTemplate } from './format.js';
import { compileReactionScore, compileSourceWhere, getSourceDefinition, getSourceDefinitions } from './sourceExpression.js';

export function buildSelectionSpecs(config, now = new Date(), keys = null, options = {}) {
  const chatId = config.telegram.sourceChatId;
  const templates = getPublishTemplates(config);
  const requestedKeys = keys ? new Set(normalizeSelectionKeys(keys, config)) : null;
  const globalFirstSendAtIso = normalizeFirstSendAt(config?.publish?.firstSendAt);
  const specs = [];

  for (const entry of templates) {
    if (!entry?.enabled && !options.includeDisabled) continue;

    const publicKey = getSelectionKey(entry);
    if (requestedKeys && !requestedKeys.has(publicKey)) continue;
    const firstSendAtIso = getEffectiveFirstSendAtIso(globalFirstSendAtIso, entry.firstSendAt);

    const posts = normalizePosts(entry.posts, entry.limit);
    const reactions = normalizeReactions(entry.reactions);
    const sourceDefinition = getSourceDefinition(config, entry.source);
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
      firstSendAtIso,
      windowHours,
      limit: posts.max,
      posts,
      reactions,
      sourceWhereSql: compileSourceWhere(sourceDefinition?.where || 'true'),
      reactionScoreSql: compileReactionScore(reactions.strategy),
      template: entry.template
    });
  }

  return specs;
}

export function getScheduledPublishEntries(config) {
  const entries = [];
  const globalFirstSendAtIso = normalizeFirstSendAt(config?.publish?.firstSendAt);
  for (const entry of getPublishTemplates(config)) {
    if (entry?.enabled && entry.schedule) {
      entries.push({
        key: getSelectionKey(entry),
        type: entry.source,
        source: entry.source,
        templateKey: entry.key,
        period: entry.key,
        schedule: entry.schedule,
        firstSendAtIso: getEffectiveFirstSendAtIso(globalFirstSendAtIso, entry.firstSendAt)
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
  const posts = await repository.getSelectionPosts(spec);
  return {
    ...spec,
    title: renderSelectionTemplate(spec, posts),
    posts
  };
}

function normalizeSelectionKey(key, config) {
  if (key === undefined || key === null || key === '') return [];
  const value = String(key);
  const templates = getPublishTemplates(config || {});

  if (value === 'fresh') return normalizeSelectionKey('day', config);

  const sources = getSourceDefinitions(config || {});
  const sourceNames = new Set(sources.map((source) => source.key));

  if (value.endsWith('.*') && sourceNames.has(value.slice(0, -2))) {
    const source = value.slice(0, -2);
    return templates
      .filter((template) => template.source === source)
      .map((template) => getSelectionKey(template));
  }

  if (sourceNames.has(value)) return normalizeSelectionKey(`${value}.*`, config);

  const sourceKeyMatch = /^([^.]+)\.([^.]+)$/.exec(value);
  if (sourceKeyMatch && sourceNames.has(sourceKeyMatch[1])) {
    if (!config) return [value];
    const [, source, key] = sourceKeyMatch;
    if (templates.some((template) => template.source === source && template.key === key)) return [value];
  }

  const exact = templates.find((template) => template.key === value);
  if (exact) return [getSelectionKey(exact)];

  throw new Error(`Unknown publish selection: ${value}. Expected a template key, source.key, or source.*.`);
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

function normalizeFirstSendAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getEffectiveFirstSendAtIso(globalFirstSendAtIso, templateFirstSendAt) {
  const templateFirstSendAtIso = normalizeFirstSendAt(templateFirstSendAt);
  if (!globalFirstSendAtIso) return templateFirstSendAtIso;
  if (!templateFirstSendAtIso) return globalFirstSendAtIso;
  return new Date(globalFirstSendAtIso) > new Date(templateFirstSendAtIso)
    ? globalFirstSendAtIso
    : templateFirstSendAtIso;
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
