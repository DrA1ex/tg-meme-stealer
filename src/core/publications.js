import { htmlPre } from './html.js';
import { formatTable } from './table.js';

export function formatPublications(publications) {
  const rows = publications || [];
  if (rows.length === 0) return htmlPre('Publications\nNo publications.');

  const tableRows = rows.map((row) => ({
    id: String(row.id),
    key: row.key || '',
    status: row.status || '',
    progress: formatProgress(row)
  }));

  return htmlPre([
    'Publications',
    '',
    formatTable(tableRows, ['id', 'key', 'status', 'progress'])
  ].join('\n'));
}

export function formatPublicationPosts(publication, posts) {
  if (!publication) return htmlPre('Publication not found.');

  const rows = posts || [];
  const lines = [
    `Publication #${publication.id}`,
    `Status: ${publication.status}`,
    `Selection: ${publication.selectionKey}`,
    `Title: ${publication.title}`,
    `Posts: ${rows.length}`
  ];

  if (publication.createdAt) lines.push(`Created: ${formatDate(publication.createdAt)}`);
  if (publication.finishedAt) lines.push(`Finished: ${formatDate(publication.finishedAt)}`);
  if (!publication.finishedAt && publication.updatedAt) lines.push(`Updated: ${formatDate(publication.updatedAt)}`);
  if (publication.lastError) lines.push(`Last error: ${trim(publication.lastError, 160)}`);
  if (rows.length === 0) return htmlPre([...lines, '', 'No posts.'].join('\n'));

  const tableRows = rows.map((row) => ({
    pos: String(row.position),
    message: String(row.messageId),
    likes: String(row.likes || 0),
    dislikes: String(row.dislikes || 0),
    sent: row.sentAt ? 'yes' : 'no',
    bot: row.botMessageId ? String(row.botMessageId) : '',
    author: trim(row.author || '', 28)
  }));

  return htmlPre([
    ...lines,
    '',
    formatTable(tableRows, ['pos', 'message', 'likes', 'dislikes', 'sent', 'bot', 'author'])
  ].join('\n'));
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
