export function createSetupMeta() {
  return {
    changedAt: 0,
    changedArea: '',
    previewedAt: 0,
    testedAt: 0
  };
}

export function setupScreen({ icon, title, sections = [] }) {
  const lines = [`${icon || '🧰'} ${title}`];
  for (const [heading, body] of sections) {
    const bodyLines = Array.isArray(body) ? body : [String(body || '')];
    lines.push('', heading, ...bodyLines.filter((line) => line !== undefined && line !== null).map(String));
  }
  return lines.join('\n');
}

export function setupHtmlScreen({ icon, title, sections = [] }) {
  const lines = [`${icon || '🧰'} ${title}`];
  for (const [heading, body] of sections) {
    const bodyLines = Array.isArray(body) ? body : [String(body || '')];
    lines.push('', heading, ...bodyLines.filter((line) => line !== undefined && line !== null).map(String));
  }
  return lines.join('\n');
}

export function isPreviewStale(meta = createSetupMeta()) {
  return Boolean(meta.changedAt && (!meta.previewedAt || meta.previewedAt < meta.changedAt));
}

export function formatRelativeSetupTime(timestamp) {
  if (!timestamp) return 'never';
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 10_000) return 'just now';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}


export function countRules(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function formatTemplateLines(templates, options = {}) {
  const visible = options.includeDisabled ? templates : templates.filter((template) => template.enabled !== false);
  if (!visible.length) return ['- none'];
  return visible.slice(0, 12).map((template) => {
    const status = template.enabled === false ? 'disabled' : 'enabled';
    const schedule = formatSchedule(template.schedule);
    const window = template.windowHours ? `, window=${template.windowHours}h` : '';
    return `- ${template.key || '<missing key>'}: ${status}, source=${template.source || '<missing source>'}, ${schedule}${window}`;
  });
}

export function formatSchedule(schedule) {
  if (!schedule) return 'schedule=missing';
  if (schedule.type === 'daily') return `daily ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'weekly') return `weekly day ${schedule.weekday ?? '?'} ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'monthly') return `monthly day ${schedule.dayOfMonth ?? '?'} ${schedule.time || '<missing time>'}`;
  return `${schedule.type || '<missing type>'} ${schedule.time || '<missing time>'}`;
}

export function getEffectiveGlobalFirstSendAt(publish) {
  return publish?.firstSendAt ? String(publish.firstSendAt) : '';
}

export function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function findScheduleConflicts(templates) {
  const enabled = templates.filter((template) => template.enabled !== false && template.schedule);
  const groups = new Map();
  for (const template of enabled) {
    const key = scheduleIdentity(template.schedule);
    groups.set(key, [...(groups.get(key) || []), template.key || '<missing key>']);
  }
  return [...groups.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([schedule, keys]) => `${schedule} is used by ${keys.join(', ')}`);
}

export function scheduleIdentity(schedule) {
  if (!schedule) return 'missing schedule';
  if (schedule.type === 'daily') return `daily:${schedule.time || ''}`;
  if (schedule.type === 'weekly') return `weekly:${schedule.weekday || ''}:${schedule.time || ''}`;
  if (schedule.type === 'monthly') return `monthly:${schedule.dayOfMonth || ''}:${schedule.time || ''}`;
  return `${schedule.type || ''}:${schedule.time || ''}`;
}

