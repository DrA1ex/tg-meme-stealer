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
import { MIN_TRAFFIC_DATABASE_POSTS } from './constants.js';
import { publishTemplate } from './publishPresets.js';

const DAY_MINUTES = 24 * 60;
const DEFAULT_TRAFFIC_DB_DAYS = 7;
const TRAFFIC_PRESET_SOURCE = { key: 'best', where: 'likes > 0' };

export function formatSchedulePreview(draft = {}, baseConfig = {}, now = new Date()) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const entries = getScheduledPublishEntries(config);
  const templates = getTemplates(config);
  const soonEvents = buildNextScheduleEvents({ entries, templates, timezone, now, limit: 8 });
  const byTemplateEvents = buildNextScheduleEventsByTemplate({ entries, templates, timezone, now });
  const firstSendLines = buildFirstSendNotes({ entries, timezone, now });

  const soonLines = soonEvents.map((event) => formatScheduleEvent(event, timezone));
  const byTemplateLines = byTemplateEvents.map((event) => formatScheduleEvent(event, timezone));

  return setupScreen({
    icon: '📅',
    title: 'Schedule preview',
    sections: [
      ['🕒 Timezone', [timezone]],
      ['📌 Soon', soonLines.length ? soonLines : ['- no enabled scheduled templates']],
      ['🧭 By template', byTemplateLines.length ? byTemplateLines : ['- no enabled scheduled templates']],
      ['🚦 First send gate', firstSendLines.length ? firstSendLines : ['- no active firstSendAt gate or no runs affected in this sample']],
      ['➡️ Next', ['Use Schedule doctor for overlap/gap warnings, or Manage templates to remove old schedules.']]
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

export function buildRecentTrafficScheduleSuggestions({ messages = [], draft = {}, baseConfig = {} } = {}) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const posts = parseMessagesToPosts(messages, {
    chatId: config.telegram?.sourceChatId,
    parsing: draft.parsing || config.parsing || {}
  });
  const rawItems = messages.map((message) => ({ id: message?.id, date: getMessageDate(message) })).filter((item) => item.date);
  const items = posts.length
    ? posts.map((post) => ({ id: post.messageId, date: new Date(post.messageDate), likes: post.likes, dislikes: post.dislikes }))
    : rawItems;
  const report = buildTrafficReport({
    items,
    timezone,
    source: posts.length ? 'recent parser-matched Telegram messages' : 'recent raw Telegram messages',
    sampleLines: [
      `Scanned ${messages.length} recent Telegram message(s).`,
      `Matched parser filters: ${posts.length}.`,
      `Rejected by parser filters: ${Math.max(0, messages.length - posts.length)}.`,
      posts.length ? 'Traffic is based on parser-matched posts.' : 'No matched posts; falling back to raw message dates.'
    ],
    allowPresets: items.length >= 5
  });

  return {
    ...report,
    scanned: messages.length,
    matched: posts.length,
    rejected: Math.max(0, messages.length - posts.length),
    mode: 'recent'
  };
}

export async function buildDatabaseTrafficScheduleSuggestions({ repository, draft = {}, baseConfig = {}, days = DEFAULT_TRAFFIC_DB_DAYS } = {}) {
  const config = buildRuntimeConfig(draft, baseConfig);
  const timezone = config.schedule?.timezone || 'UTC';
  const chatId = config.telegram?.sourceChatId;
  const safeDays = Math.max(1, Number(days || DEFAULT_TRAFFIC_DB_DAYS));
  const sinceIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();

  if (!repository?.all) {
    return {
      message: setupScreen({
        icon: '📊',
        title: 'Extended traffic suggestions',
        sections: [
          ['⚠️ Unable to analyze database', ['Repository is not available in this setup context.']],
          ['➡️ Next', ['Run this from the normal app/setup process with an initialized database.']]
        ]
      }),
      presets: [],
      mode: 'database',
      days: safeDays
    };
  }

  const rows = await repository.all(
    `
      SELECT message_id AS messageId, likes, dislikes, message_date AS messageDate
      FROM posts
      WHERE chat_id = ?
        AND message_date >= ?
      ORDER BY message_date DESC, message_id DESC
    `,
    [String(chatId), sinceIso]
  );

  const items = rows
    .map((row) => ({
      id: row.messageId,
      date: new Date(row.messageDate),
      likes: Number(row.likes || 0),
      dislikes: Number(row.dislikes || 0)
    }))
    .filter((item) => item.date instanceof Date && !Number.isNaN(item.date.getTime()));

  const tooSmall = items.length < MIN_TRAFFIC_DATABASE_POSTS;
  const report = buildTrafficReport({
    items,
    timezone,
    source: `database posts from last ${safeDays} day(s)`,
    sampleLines: [
      `Stored parsed posts in range: ${items.length}.`,
      `Range: last ${safeDays} day(s).`,
      `Chat: ${chatId || '<missing sourceChatId>'}.`,
      tooSmall
        ? `Small database sample: ${MIN_TRAFFIC_DATABASE_POSTS}+ stored posts are better for confidence; low-volume samples may be limited to monthly suggestions.`
        : 'Traffic is based on stored, already parsed posts.'
    ],
    allowPresets: items.length >= 5
  });

  return {
    ...report,
    mode: 'database',
    days: safeDays,
    tooSmall,
    count: items.length
  };
}

export function formatTrafficScheduleSuggestions(report) {
  return report.message;
}

export function getMaxTrafficDays(config = {}) {
  const values = [
    Number(config.sync?.retentionDays),
    Number(config.sync?.initialScanDays),
    Number(config.sync?.refreshRecentDays)
  ].filter((value) => Number.isFinite(value) && value > 0);
  return Math.min(365, Math.max(7, ...values, 30));
}

export function buildTrafficPreset({ id, title, kind, time, morningTime, nightTime, notes = [] }) {
  if (kind === 'monthly') {
    return {
      id,
      title,
      description: `Traffic-based monthly digest on day 1 at ${time}.`,
      sources: [TRAFFIC_PRESET_SOURCE],
      templates: [
        publishTemplate({
          source: 'best',
          key: 'monthly_best',
          schedule: { type: 'monthly', dayOfMonth: 1, time },
          windowHours: 720,
          posts: { min: 3, target: 10, max: 20 },
          reactions: { strategy: 'likes', min: 5, includeAbove: 20 },
          template: 'Best {{count}} posts from the last month'
        })
      ],
      notes
    };
  }

  if (kind === 'weekly') {
    return {
      id,
      title,
      description: `Traffic-based weekly digest on Monday at ${time}.`,
      sources: [TRAFFIC_PRESET_SOURCE],
      templates: [
        publishTemplate({
          source: 'best',
          key: 'weekly_best',
          schedule: { type: 'weekly', weekday: 1, time },
          windowHours: 168,
          posts: { min: 5, target: 10, max: 20 },
          reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
          template: 'Best {{count}} posts from the last week'
        })
      ],
      notes
    };
  }

  if (kind === 'twice_weekly') {
    return {
      id,
      title,
      description: `Traffic-based twice-weekly digest on Monday/Thursday at ${time}.`,
      sources: [TRAFFIC_PRESET_SOURCE],
      templates: [
        publishTemplate({
          source: 'best',
          key: 'twice_weekly_best_mon',
          schedule: { type: 'weekly', weekday: 1, time },
          windowHours: 84,
          posts: { min: 3, target: 7, max: 14 },
          reactions: { strategy: 'likes', min: 10, includeAbove: 25 },
          template: 'Best {{count}} posts from the last half-week'
        }),
        publishTemplate({
          source: 'best',
          key: 'twice_weekly_best_thu',
          schedule: { type: 'weekly', weekday: 4, time },
          windowHours: 84,
          posts: { min: 3, target: 7, max: 14 },
          reactions: { strategy: 'likes', min: 10, includeAbove: 25 },
          template: 'Best {{count}} posts from the last half-week'
        })
      ],
      notes
    };
  }

  if (kind === 'morning_night') {
    return {
      id,
      title,
      description: `Traffic-based morning/night split at ${morningTime} and ${nightTime}.`,
      sources: [TRAFFIC_PRESET_SOURCE],
      templates: [
        publishTemplate({
          source: 'best',
          key: 'daily_morning_best',
          schedule: { type: 'daily', time: morningTime },
          windowHours: 12,
          posts: { min: 5, target: 10, max: 20 },
          reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
          template: 'Best {{count}} morning fresh posts'
        }),
        publishTemplate({
          source: 'best',
          key: 'daily_night_best',
          schedule: { type: 'daily', time: nightTime },
          windowHours: 12,
          posts: { min: 5, target: 10, max: 20 },
          reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
          template: 'Best {{count}} night fresh posts'
        })
      ],
      notes
    };
  }

  return {
    id,
    title,
    description: `Traffic-based daily digest at ${time}.`,
    sources: [TRAFFIC_PRESET_SOURCE],
    templates: [
      publishTemplate({
        source: 'best',
        key: 'daily_best',
        schedule: { type: 'daily', time },
        windowHours: 24,
        posts: { min: 5, target: 10, max: 20 },
        reactions: { strategy: 'likes', min: 20, includeAbove: 30 },
        template: 'Best {{count}} posts from the last 24h'
      })
    ],
    notes
  };
}

function buildRuntimeConfig(draft, baseConfig) {
  return deepMerge(baseConfig, buildDraftConfig(draft));
}

function getTemplates(config) {
  return Array.isArray(config.publish?.template) ? config.publish.template : [];
}

function formatScheduleEvent(event, timezone) {
  const windowEnd = new Date(event.runAt.getTime() - Number(event.template?.offsetHours || 0) * 60 * 60 * 1000);
  const windowStart = new Date(windowEnd.getTime() - Number(event.template?.windowHours || 24) * 60 * 60 * 1000);
  return `- ${formatLocalDateTime(event.runAt, timezone)} · ${event.key} · window ${formatLocalDateTime(windowStart, timezone)}–${formatLocalDateTime(windowEnd, timezone)}`;
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

function buildNextScheduleEventsByTemplate({ entries, templates, timezone, now }) {
  const templateByKey = new Map(templates.map((template) => [`${template.source}.${template.key}`, template]));
  return entries
    .map((entry) => ({
      key: entry.key,
      entry,
      template: templateByKey.get(entry.key),
      runAt: getNextEligibleScheduledRunAsDate({ now, schedule: entry.schedule, timezone, firstSendAtIso: entry.firstSendAtIso })
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
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
    end: normalizeMinutes(parseTimeToMinutes(template.schedule.time) - Number(template.offsetHours || 0) * 60),
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

function buildTrafficReport({ items, timezone, source, sampleLines, allowPresets }) {
  const buckets = buildHourlyBuckets(items, timezone);
  const topHours = [...buckets.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5);
  const activeClusters = buildActiveClusters(buckets);
  const metrics = getTrafficMetrics(items);
  const suggestionLines = buildScheduleSuggestionsFromTraffic({ topHours, activeClusters, metrics });
  const presets = allowPresets ? buildTrafficPresetsFromTraffic({ topHours, activeClusters, metrics }) : [];

  const bucketLines = topHours.map(([hour, count]) => `- ${formatHour(hour)}–${formatHour(hour + 1)}: ${count} post/message(s)`);
  const clusterLines = activeClusters.slice(0, 4).map((cluster) => `- ${formatHour(cluster.start)}–${formatHour(cluster.end)}: ${cluster.count} post/message(s)`);

  return {
    presets,
    message: setupScreen({
      icon: '📊',
      title: 'Traffic-aware schedule suggestions',
      sections: [
        ['🔎 Sample', [
          ...sampleLines,
          `Source: ${source}.`,
          `Timezone: ${timezone}.`
        ]],
        ['📌 Traffic summary', [
          `Items: ${metrics.total}.`,
          `Active days: ${metrics.activeDays}.`,
          `Average: ${formatNumber(metrics.avgPerDay)} post/message(s) per day.`,
          `Recommended cadence: ${metrics.cadence}.`
        ]],
        ['⏱ Busiest hours', bucketLines.length ? bucketLines : ['- no dated posts/messages found']],
        ['📈 Active clusters', clusterLines.length ? clusterLines : ['- no activity clusters found']],
        ['💡 Suggested schedules', suggestionLines.length ? suggestionLines.map((item) => `- ${item}`) : ['- not enough traffic data for a confident suggestion']],
        ['🧩 Actions', presets.length
          ? presets.map((preset) => `- ${preset.title}: can be applied from buttons below.`)
          : ['- no apply buttons because the sample is too small or empty.']],
        ['➡️ Next', ['Use Apply buttons to add/update schedules, or run extended suggestions from database for a longer range.']]
      ]
    })
  };
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

function buildScheduleSuggestionsFromTraffic({ topHours, activeClusters, metrics }) {
  if (!topHours.length) return [];
  const suggestions = [];
  const busiestHour = topHours[0][0];
  const dailyTime = formatTime((busiestHour + 1) % 24, 0);
  const split = chooseMorningNightTimes(activeClusters) || { morningTime: '11:00', nightTime: '23:00' };

  if (metrics.avgPerDay < 0.5) {
    suggestions.push(`Monthly digest around ${dailyTime}: traffic is too sparse for weekly publishing.`);
    suggestions.push('Use lower post/reaction minimums if even a monthly window may have too few posts.');
  } else if (metrics.avgPerDay < 1) {
    suggestions.push(`Monthly digest around ${dailyTime}: low traffic, safer than weekly.`);
    suggestions.push(`Weekly digest around ${dailyTime}: possible only with loose post/reaction thresholds.`);
  } else if (metrics.avgPerDay < 3) {
    suggestions.push(`Weekly digest around ${dailyTime}: low traffic, safer than daily.`);
    suggestions.push(`Twice weekly around ${dailyTime}: possible only if each half-week has enough posts.`);
  } else if (metrics.avgPerDay < 8) {
    suggestions.push(`Daily digest around ${dailyTime}: enough posts for one daily run.`);
    suggestions.push(`Twice weekly around ${dailyTime}: safer fallback if reaction thresholds are strict.`);
  } else {
    suggestions.push(`Daily digest around ${dailyTime}: one digest shortly after the busiest hour.`);
    suggestions.push(`Morning + night around ${split.morningTime} / ${split.nightTime}: enough traffic for two daily windows.`);
  }

  if (metrics.avgPerDay >= 20) suggestions.push('High volume: consider strict thresholds or two daily selections.');
  return suggestions;
}

function buildTrafficPresetsFromTraffic({ topHours, activeClusters, metrics }) {
  if (!topHours.length) return [];
  const presets = [];
  const busiestHour = topHours[0][0];
  const dailyTime = formatTime((busiestHour + 1) % 24, 0);
  const split = chooseMorningNightTimes(activeClusters) || { morningTime: '11:00', nightTime: '23:00' };

  if (metrics.avgPerDay >= 20) {
    presets.push(buildTrafficPreset({
      id: `traffic_daily_${dailyTime.replace(':', '')}`,
      title: `Apply daily digest · ${dailyTime}`,
      kind: 'daily',
      time: dailyTime,
      notes: ['Generated from observed traffic. Apply/update keeps unrelated templates.']
    }));
  }

  if (metrics.avgPerDay >= 50) {
    presets.push(buildTrafficPreset({
      id: `traffic_mn_${split.morningTime.replace(':', '')}_${split.nightTime.replace(':', '')}`,
      title: `Apply morning/night · ${split.morningTime} / ${split.nightTime}`,
      kind: 'morning_night',
      morningTime: split.morningTime,
      nightTime: split.nightTime,
      notes: ['Generated from observed traffic. Apply/update keeps unrelated templates.']
    }));
  }

  if (metrics.avgPerDay < 1) {
    presets.push(buildTrafficPreset({
      id: `traffic_monthly_${dailyTime.replace(':', '')}`,
      title: `Apply monthly digest · day 1 ${dailyTime}`,
      kind: 'monthly',
      time: dailyTime,
      notes: ['Generated from very low-volume traffic. Creates one monthly schedule.']
    }));
  }

  if (metrics.avgPerDay < 8) {
    presets.push(buildTrafficPreset({
      id: `traffic_twice_weekly_${dailyTime.replace(':', '')}`,
      title: `Apply twice weekly · Mon/Thu ${dailyTime}`,
      kind: 'twice_weekly',
      time: dailyTime,
      notes: ['Generated from observed low-volume traffic. Creates Monday and Thursday weekly schedules.']
    }));
  }

  if (metrics.avgPerDay >= 3) {
    presets.push(buildTrafficPreset({
      id: `traffic_weekly_${dailyTime.replace(':', '')}`,
      title: `Apply weekly digest · Mon ${dailyTime}`,
      kind: 'weekly',
      time: dailyTime,
      notes: ['Generated from observed traffic. Good fallback for low-volume sources.']
    }));
  }

  return presets;
}

function getTrafficMetrics(items = []) {
  const dates = items
    .map((item) => item.date)
    .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);
  if (!dates.length) return { total: 0, activeDays: 0, avgPerDay: 0, cadence: 'not enough data' };
  const days = new Set(dates.map((date) => date.toISOString().slice(0, 10)));
  const spanDays = Math.max(1, Math.ceil((dates[dates.length - 1] - dates[0]) / 86400000) + 1);
  const avgPerDay = items.length / spanDays;
  return {
    total: items.length,
    activeDays: days.size,
    avgPerDay,
    cadence: recommendCadence(avgPerDay)
  };
}

function recommendCadence(avgPerDay) {
  if (avgPerDay >= 20) return 'two daily runs or strict daily digest';
  if (avgPerDay >= 8) return 'daily or morning/night';
  if (avgPerDay >= 3) return 'daily digest';
  if (avgPerDay >= 1) return 'weekly or twice weekly';
  if (avgPerDay >= 0.5) return 'monthly digest, weekly only with loose thresholds';
  if (avgPerDay > 0) return 'monthly digest';
  return 'not enough data';
}

function formatNumber(value) {
  const number = Number(value || 0);
  return number.toFixed(number >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

function chooseMorningNightTimes(activeClusters) {
  const morningCluster = activeClusters.find((cluster) => normalizeHour(cluster.start) < 14);
  const eveningCluster = activeClusters.find((cluster) => normalizeHour(cluster.start) >= 14) || activeClusters[0];
  if (!morningCluster || !eveningCluster || morningCluster === eveningCluster) return null;
  return {
    morningTime: formatTime(normalizeHour(morningCluster.end + 1), 0),
    nightTime: formatTime(normalizeHour(eveningCluster.end + 1), 0)
  };
}

function normalizeHour(hour) {
  const value = hour % 24;
  return value < 0 ? value + 24 : value;
}

function normalizeMinutes(minutes) {
  const value = minutes % DAY_MINUTES;
  return value < 0 ? value + DAY_MINUTES : value;
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
