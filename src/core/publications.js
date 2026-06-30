import { formatTable } from './table.js';

export function formatPublications(publications) {
  const rows = publications || [];
  if (rows.length === 0) return 'Publications\nNo publications.';

  const tableRows = rows.map((row) => ({
    id: String(row.id),
    status: row.status || '',
    selection: row.selectionKey || '',
    progress: formatProgress(row),
    updated: formatDate(row.finishedAt || row.updatedAt || row.createdAt),
    title: trim(row.title || '', 32)
  }));

  return [
    'Publications',
    '```',
    formatTable(tableRows, ['id', 'status', 'selection', 'progress', 'updated', 'title']),
    '```'
  ].join('\n');
}

export function formatPublicationPosts(publication, posts) {
  if (!publication) return 'Publication not found.';

  const rows = posts || [];
  const lines = [
    `Publication #${publication.id}`,
    `Status: ${publication.status}`,
    `Selection: ${publication.selectionKey}`,
    `Title: ${publication.title}`,
    `Posts: ${rows.length}`
  ];

  if (publication.lastError) lines.push(`Last error: ${trim(publication.lastError, 160)}`);
  if (rows.length === 0) return [...lines, '', 'No posts.'].join('\n');

  const tableRows = rows.map((row) => ({
    pos: String(row.position),
    message: String(row.messageId),
    likes: String(row.likes || 0),
    dislikes: String(row.dislikes || 0),
    sent: row.sentAt ? 'yes' : 'no',
    bot: row.botMessageId ? String(row.botMessageId) : '',
    author: trim(row.author || '', 28)
  }));

  return [
    ...lines,
    '',
    '```',
    formatTable(tableRows, ['pos', 'message', 'likes', 'dislikes', 'sent', 'bot', 'author']),
    '```'
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

function trim(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
