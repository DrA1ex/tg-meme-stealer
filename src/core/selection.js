import { subtractDays, subtractHours, subtractMonths } from './date.js';
import { renderTemplate } from './format.js';

const PERIODS = ['month', 'week', 'day'];
const TYPES = ['best', 'controversial'];

export function buildSelectionSpecs(config, now = new Date(), keys = null) {
  const chatId = config.telegram.sourceChatId;
  const requestedKeys = keys ? new Set(normalizeSelectionKeys(keys)) : null;
  const specs = [];

  for (const type of TYPES) {
    for (const period of PERIODS) {
      const entry = config.publish?.selections?.[type]?.[period];
      if (!entry?.enabled) continue;

      const key = `${type}.${period}`;
      if (requestedKeys && !requestedKeys.has(key)) continue;

      specs.push({
        key,
        type,
        period,
        chatId,
        sinceIso: getPeriodStart(period, entry, now).toISOString(),
        untilIso: now.toISOString(),
        limit: entry.limit,
        template: entry.template,
        threshold: entry.threshold
      });
    }
  }

  return specs;
}

export function getScheduledPublishEntries(config) {
  const entries = [];
  for (const type of TYPES) {
    for (const period of PERIODS) {
      const entry = config.publish?.selections?.[type]?.[period];
      if (entry?.enabled && entry.time) {
        entries.push({ key: `${type}.${period}`, time: entry.time });
      }
    }
  }
  return entries;
}

export function normalizeSelectionKeys(keys) {
  const values = Array.isArray(keys) ? keys : [keys];
  return values.flatMap((key) => normalizeSelectionKey(key)).filter(Boolean);
}

export async function loadSelections(repository, config, now = new Date(), keys = null) {
  const specs = buildSelectionSpecs(config, now, keys);
  const selections = [];

  for (const spec of specs) {
    const posts = spec.type === 'controversial'
      ? await repository.getControversialPosts(spec)
      : await repository.getTopPosts(spec);
    selections.push({
      ...spec,
      title: renderSelectionTemplate(spec, posts),
      posts
    });
  }

  return selections;
}

function normalizeSelectionKey(key) {
  if (key === undefined || key === null || key === '') return [];
  if (key === 'fresh') return ['best.day'];
  if (PERIODS.includes(key)) return [`best.${key}`];
  if (TYPES.includes(key)) return PERIODS.map((period) => `${key}.${period}`);
  if (/^(best|controversial)\.(month|week|day)$/.test(key)) return [key];
  throw new Error(`Unknown publish selection: ${key}. Expected month, week, day, best.*, or controversial.*.`);
}

function getPeriodStart(period, entry, now) {
  if (period === 'month') return subtractMonths(now, 1);
  if (period === 'week') return subtractDays(now, 7);
  return subtractHours(now, entry.windowHours || 24);
}

function renderSelectionTemplate(spec, posts) {
  return renderTemplate(spec.template || spec.key, {
    key: spec.key,
    type: spec.type,
    period: spec.period,
    count: posts.length,
    limit: spec.limit,
    threshold: spec.threshold,
    windowHours: spec.period === 'day' ? hoursBetween(spec.sinceIso, spec.untilIso) : ''
  }).trim();
}

function hoursBetween(sinceIso, untilIso) {
  return Math.round((new Date(untilIso).getTime() - new Date(sinceIso).getTime()) / 60 / 60 / 1000);
}
