import { htmlPre } from './html.js';
import { formatTable } from './table.js';

export function formatJobs(jobs) {
  const active = jobs.active || [];
  const finished = jobs.finished || [];
  const sections = ['Publication jobs'];

  sections.push(formatJobSection('Active', active));
  sections.push(formatJobSection('Recent finished', finished));

  return htmlPre(sections.join('\n\n'));
}

function formatJobSection(title, rows) {
  if (rows.length === 0) return `${title}\nNo jobs.`;

  const tableRows = rows.map((row) => ({
    id: String(row.id),
    status: row.status || '',
    selection: row.selectionKey || '',
    progress: formatProgress(row),
    updated: formatDate(row.finishedAt || row.updatedAt || row.createdAt),
    error: trimError(row.lastError || '')
  }));

  return [
    title,
    formatTable(tableRows, ['id', 'status', 'selection', 'progress', 'updated', 'error'])
  ].join('\n');
}

function formatProgress(row) {
  const expected = Number(row.expectedCount || 0);
  const sent = Number(row.sentCount || 0);
  if (!expected) return String(sent);
  return `${sent}/${expected}`;
}

function formatDate(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function trimError(value) {
  if (!value) return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}
