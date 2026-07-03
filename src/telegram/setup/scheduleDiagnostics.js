import { buildDraftConfig } from '../../core/setupConfig.js';
import { parseMessagesToPosts } from '../../core/postParser.js';
import { deepMerge } from '../../config/index.js';
import { getScheduledPublishEntries } from '../../core/selection.js';
import {
  getNextEligibleScheduledRunAsDate,
  getNextScheduledRunAsDate,
  getPreviousScheduledRunAsDate
} from '../../runtime/scheduler.js';
import { findScheduleConflicts, formatSchedule, setupScreen } from './formattingBase.js';

const DAY_MINUTES = 24 * 60;

export function formatSchedulePreview(draft = {}, baseConfig = {}, now = new Date()) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const entries = getScheduledPublishEntries(config);
  const templates = getTemplates(config);
  const events = buildNextScheduleEvents({ entries, templates, timezone, now, limit: 8 });
  const firstSendLines = buildFirstSendNotes({ entries, timezone, now });

  const eventLines = events.map((event) => {
    const windowStart = new Date(event.runAt.getTime() - Number(event.template?.windowHours || 24) * 60 * 60 * 1000);
    return `- ${formatLocalDateTime(event.runAt, timezone)} · ${event.key} · window ${formatLocalTime(windowStart, timezone)}–${formatLocalTime(event.runAt, timezone)}`;
  });

  return setupScreen({
    icon: '📅',
    title: 'Schedule preview',
    sections: [
      ['🕒 Timezone', [timezone]],
      ['📌 Next planned publications', eventLines.length ? eventLines : ['- no enabled scheduled templates']],
      ['🚦 First send gate', firstSendLines.length ? firstSendLines : ['- no active firstSendAt gate or no runs affected in this sample']],
      ['➡️ Next', ['Use Schedule doctor for overlap/gap warnings, or Presets to rebuild common schedules.']]
    ]
  });
}

export function formatScheduleDoctor(draft = {}, baseConfig = {}, now = new Date()) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const templates = getTemplates(config).filter((template) => template.enabled !== false);
  const warnings = [];
  const notes = [];

  for (const conflict of findScheduleConflicts(templates)) {
    warnings.push(`Schedule conflict: ${conflict}.`);
  }

  for (const warning of analyzeDailyWindowsBySource(templates)) warnings.push(warning);

  const entries = getScheduledPublishEntries(config);
  for (const entry of entries) {
    const nextRaw = getNextScheduledRunAsDate({ now, schedule: entry.schedule, timezone });
    const nextEligible = getNextEligibleScheduledRunAsDate({ now, schedule: entry.schedule, timezone, firstSendAtIso: entry.firstSendAtIso });
    if (entry.firstSendAtIso && nextRaw.getTime() !== nextEligible.getTime()) {
      notes.push(`${entry.key}: firstSendAt shifts next run from ${formatLocalDateTime(nextRaw, timezone)} to ${formatLocalDateTime(nextEligible, timezone)}.`);
    }

    const previous = getPreviousScheduledRunAsDate({ now, schedule: entry.schedule, timezone });
    if (entry.firstSendAtIso && previous < new Date(entry.firstSendAtIso)) {
      notes.push(`${entry.key}: catch-up before ${formatLocalDateTime(new Date(entry.firstSendAtIso), timezone)} would be skipped.`);
    }
  }

  if (!templates.length) warnings.push('No enabled publish templates configured.');

  return setupScreen({
    icon: '🩺',
    title: 'Schedule doctor',
    sections: [
      ['⚠️ Warnings', warnings.length ? warnings.map((item) => `- ${item}`) : ['none']],
      ['📝 Notes', notes.length ? notes.map((item) => `- ${item}`) : ['none']],
      ['➡️ Next', ['Use Schedule preview to see concrete upcoming runs and selection windows.']]
    ]
  });
}


export function formatTrafficScheduleSuggestions({ messages = [], draft = {}, baseConfig = {}, now = new Date() } = {}) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const posts = parseMessagesToPosts(messages, {
    chatId: config.telegram?.sourceChatId,
    parsing: draft.parsing || config.parsing || {}
  });
  const datedItems = posts.length
    ? posts.map((post) => ({ id: post.messageId, date: new Date(post.messageDate) }))
    : messages.map((message) => ({ id: message?.id, date: getMessageDate(message) })).filter((item) => item.date);
  const buckets = buildHourlyBuckets(datedItems, timezone);
  const topHours = [...buckets.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5);
  const activeClusters = buildActiveClusters(buckets);
  const suggestions = buildScheduleSuggestionsFromTraffic({ topHours, activeClusters });

  const bucketLines = topHours.map(([hour, count]) => `- ${formatHour(hour)}–${formatHour(hour + 1)}: ${count} post/message(s)`);
  const clusterLines = activeClusters.slice(0, 4).map((cluster) => `- ${formatHour(cluster.start)}–${formatHour(cluster.end)}: ${cluster.count} post/message(s)`);

  return setupScreen({
    icon: '📊',
    title: 'Traffic-aware schedule suggestions',
    sections: [
      ['🔎 Sample', [
        `Scanned ${messages.length} recent message(s).`,
        posts.length ? `Using ${posts.length} parser-matched post(s).` : 'No matched posts; falling back to raw message dates.',
        `Timezone: ${timezone}.`
      ]],
      ['⏱ Busiest hours', bucketLines.length ? bucketLines : ['- no dated messages found']],
      ['📈 Active clusters', clusterLines.length ? clusterLines : ['- no activity clusters found']],
      ['💡 Suggested schedules', suggestions.length ? suggestions.map((item) => `- ${item}`) : ['- not enough traffic data for a confident suggestion']],
      ['➡️ Next', ['Use Publish presets for a close starting point, then adjust exact times in Advanced JSON if needed.']]
    ]
  });
}

function buildRuntimeConfig(draft, baseConfig) {
  return deepMerge(baseConfig, buildDraftConfig(draft));
}

function getTemplates(config) {
  return Array.isArray(config.publish?.template) ? config.publish.template : [];
}

function buildNextScheduleEvents({ entries, templates, timezone, now, limit }) {
  const templateByKey = new Map(templates.map((template) => [`${template.source}.${template.key}`, template]));
  const state = entries.map((entry) => ({
    entry,
    runAt: getNextEligibleScheduledRunAsDate({ now, schedule: entry.schedule, timezone, firstSendAtIso: entry.firstSendAtIso })
  }));
  const events = [];

  while (state.length && events.length < limit) {
    state.sort((a, b) => a.runAt - b.runAt || a.entry.key.localeCompare(b.entry.key));
    const item = state.shift();
    const template = templateByKey.get(item.entry.key);
    events.push({ key: item.entry.key, runAt: item.runAt, entry: item.entry, template });
    state.push({
      entry: item.entry,
      runAt: getNextEligibleScheduledRunAsDate({
        now: new Date(item.runAt.getTime() + 1000),
        schedule: item.entry.schedule,
        timezone,
        firstSendAtIso: item.entry.firstSendAtIso
      })
    });
  }

  return events;
}

function buildFirstSendNotes({ entries, timezone, now }) {
  const lines = [];
  for (const entry of entries) {
    if (!entry.firstSendAtIso) continue;
    const blockedUntil = new Date(entry.firstSendAtIso);
    const previous = getPreviousScheduledRunAsDate({ now, schedule: entry.schedule, timezone });
    const nextRaw = getNextScheduledRunAsDate({ now, schedule: entry.schedule, timezone });
    const nextEligible = getNextEligibleScheduledRunAsDate({ now, schedule: entry.schedule, timezone, firstSendAtIso: entry.firstSendAtIso });
    if (previous < blockedUntil) {
      lines.push(`- ${entry.key}: previous ${formatLocalDateTime(previous, timezone)} is before gate ${formatLocalDateTime(blockedUntil, timezone)}.`);
    }
    if (nextRaw < blockedUntil) {
      lines.push(`- ${entry.key}: next raw run ${formatLocalDateTime(nextRaw, timezone)} is shifted to ${formatLocalDateTime(nextEligible, timezone)}.`);
    }
  }
  return lines;
}

function analyzeDailyWindows(templates) {
  const daily = templates.filter((template) => template.schedule?.type === 'daily');
  if (daily.length <= 1) return [];
  const warnings = [];
  const intervals = daily.map((template) => ({
    key: template.key || '<missing key>',
    end: parseTimeToMinutes(template.schedule.time),
    duration: Math.max(0, Number(template.windowHours || 24) * 60)
  }));

  for (const interval of intervals) {
    if (interval.duration > DAY_MINUTES) warnings.push(`${interval.key}: daily window is longer than 24h.`);
  }

  const expanded = intervals.flatMap((interval) => splitCircularInterval(interval));
  const overlapPairs = [];
  for (let i = 0; i < expanded.length; i += 1) {
    for (let j = i + 1; j < expanded.length; j += 1) {
      if (expanded[i].key === expanded[j].key) continue;
      const overlap = Math.min(expanded[i].end, expanded[j].end) - Math.max(expanded[i].start, expanded[j].start);
      if (overlap > 0) overlapPairs.push(`${expanded[i].key} and ${expanded[j].key} overlap by ${formatMinutes(overlap)}`);
    }
  }

  for (const pair of [...new Set(overlapPairs)].slice(0, 5)) warnings.push(pair + '.');

  const coverage = mergeIntervals(expanded);
  const covered = coverage.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  if (covered < DAY_MINUTES) warnings.push(`Daily windows leave ${formatMinutes(DAY_MINUTES - covered)} uncovered.`);

  return warnings;
}

function splitCircularInterval({ key, end, duration }) {
  const clipped = Math.min(duration, DAY_MINUTES);
  let start = (end - clipped) % DAY_MINUTES;
  if (start < 0) start += DAY_MINUTES;
  if (clipped >= DAY_MINUTES) return [{ key, start: 0, end: DAY_MINUTES }];
  if (start < end) return [{ key, start, end }];
  return [{ key, start, end: DAY_MINUTES }, { key, start: 0, end }];
}

function mergeIntervals(intervals) {
  const sorted = intervals.map((item) => ({ start: item.start, end: item.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }
  return merged;
}


function analyzeDailyWindowsBySource(templates) {
  const daily = templates.filter((template) => template.schedule?.type === 'daily');
  if (daily.length <= 1) return [];
  const warnings = [];
  const groups = new Map();
  for (const template of daily) {
    const key = template.source || '<missing source>';
    groups.set(key, [...(groups.get(key) || []), template]);
  }

  for (const [source, group] of groups.entries()) {
    if (group.length <= 1) continue;
    warnings.push(...analyzeDailyWindows(group).map((warning) => `${source}: ${warning}`));
  }

  const allDailyTimes = new Map();
  for (const template of daily) {
    const timeKey = `${template.schedule?.time || '<missing>'}`;
    allDailyTimes.set(timeKey, [...(allDailyTimes.get(timeKey) || []), `${template.source || '?'}.${template.key || '?'}`]);
  }
  for (const [time, keys] of allDailyTimes.entries()) {
    if (keys.length > 1) warnings.push(`daily ${time}: ${keys.join(', ')} run at the same time.`);
  }

  return [...new Set(warnings)];
}

function getMessageDate(message) {
  if (!message) return null;
  if (message.date instanceof Date) return message.date;
  const value = Number(message.date);
  if (!Number.isFinite(value)) return null;
  return new Date(value > 10_000_000_000 ? value : value * 1000);
}

function buildHourlyBuckets(items, timezone) {
  const buckets = new Map(Array.from({ length: 24 }, (_, hour) => [hour, 0]));
  for (const item of items) {
    if (!(item.date instanceof Date) || Number.isNaN(item.date.getTime())) continue;
    const hour = getLocalHour(item.date, timezone);
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }
  return buckets;
}

function getLocalHour(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
}

function buildActiveClusters(buckets) {
  const positive = [...buckets.entries()].filter(([, count]) => count > 0);
  if (!positive.length) return [];
  const threshold = Math.max(1, Math.ceil(Math.max(...positive.map(([, count]) => count)) * 0.35));
  const active = new Set(positive.filter(([, count]) => count >= threshold).map(([hour]) => hour));
  const clusters = [];
  let current = null;
  for (let hour = 0; hour < 24; hour += 1) {
    if (!active.has(hour)) {
      if (current) clusters.push(current);
      current = null;
      continue;
    }
    if (!current) current = { start: hour, end: hour + 1, count: buckets.get(hour) || 0 };
    else {
      current.end = hour + 1;
      current.count += buckets.get(hour) || 0;
    }
  }
  if (current) clusters.push(current);

  if (clusters.length > 1 && clusters[0].start === 0 && clusters[clusters.length - 1].end === 24) {
    const first = clusters.shift();
    const last = clusters.pop();
    clusters.unshift({ start: last.start, end: first.end + 24, count: first.count + last.count });
  }

  return clusters.sort((a, b) => b.count - a.count || a.start - b.start);
}

function buildScheduleSuggestionsFromTraffic({ topHours, activeClusters }) {
  if (!topHours.length) return [];
  const suggestions = [];
  const busiestHour = topHours[0][0];
  const dailyTime = formatTime((busiestHour + 1) % 24, 0);
  suggestions.push(`Daily top around ${dailyTime}: one digest shortly after the busiest hour.`);

  const morningCluster = activeClusters.find((cluster) => normalizeHour(cluster.start) < 14);
  const eveningCluster = activeClusters.find((cluster) => normalizeHour(cluster.start) >= 14) || activeClusters[0];
  if (morningCluster && eveningCluster && morningCluster !== eveningCluster) {
    suggestions.push(`Morning + night around ${formatTime(normalizeHour(morningCluster.end + 1), 0)} / ${formatTime(normalizeHour(eveningCluster.end + 1), 0)}: split the day around active clusters.`);
  } else {
    suggestions.push('Morning + night 11:00 / 23:00: use the standard split if traffic is spread out or sample is small.');
  }

  if (topHours.length >= 3) {
    const latestTop = Math.max(...topHours.slice(0, 3).map(([hour]) => hour));
    suggestions.push(`Night digest around ${formatTime((latestTop + 1) % 24, 0)}: good if most reactions arrive later in the day.`);
  }
  return suggestions;
}

function normalizeHour(hour) {
  const value = hour % 24;
  return value < 0 ? value + 24 : value;
}

function formatHour(hour) {
  return formatTime(normalizeHour(hour), 0);
}

function formatTime(hour, minute) {
  return `${String(normalizeHour(hour)).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeToMinutes(time) {
  const [, hour, minute] = String(time || '00:00').match(/^(\d{1,2}):(\d{2})$/) || [];
  return Math.min(DAY_MINUTES - 1, Math.max(0, Number(hour || 0) * 60 + Number(minute || 0)));
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function formatLocalDateTime(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(',', '');
}

function formatLocalTime(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}
