import { subtractDays, subtractHours, subtractMonths } from './date.js';

export function buildSelectionSpecs(config, now = new Date(), keys = null) {
  const chatId = config.telegram.sourceChatId;
  const keySet = keys ? new Set(Array.isArray(keys) ? keys : [keys]) : null;
  return [
    {
      key: 'month',
      title: config.templates?.publish?.selectionTitles?.month || 'Best posts from the last month',
      chatId,
      sinceIso: subtractMonths(now, 1).toISOString(),
      untilIso: now.toISOString(),
      limit: config.publish.monthTopLimit
    },
    {
      key: 'week',
      title: config.templates?.publish?.selectionTitles?.week || 'Best posts from the last week',
      chatId,
      sinceIso: subtractDays(now, 7).toISOString(),
      untilIso: now.toISOString(),
      limit: config.publish.weekTopLimit
    },
    {
      key: 'fresh',
      title: config.templates?.publish?.selectionTitles?.fresh || 'Best fresh posts',
      chatId,
      sinceIso: subtractHours(now, config.publish.freshWindowHours).toISOString(),
      untilIso: now.toISOString(),
      limit: config.publish.freshTopLimit
    }
  ].filter((spec) => !keySet || keySet.has(spec.key));
}

export async function loadSelections(repository, config, now = new Date(), keys = null) {
  const specs = buildSelectionSpecs(config, now, keys);
  const selections = [];

  for (const spec of specs) {
    const posts = await repository.getTopPosts(spec);
    selections.push({ ...spec, posts });
  }

  return selections;
}
