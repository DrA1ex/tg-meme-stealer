import { subtractDays, subtractHours, subtractMonths } from './date.js';
import { renderTemplate } from './format.js';

export async function buildStats(repository, config, now = new Date()) {
  const chatId = String(config.telegram.sourceChatId);
  const recentSinceIso = subtractDays(now, config.sync.refreshRecentDays).toISOString();
  const freshSinceIso = subtractHours(now, 24).toISOString();
  const all = await repository.all(
    `
      SELECT COUNT(*) AS count,
             COALESCE(SUM(likes), 0) AS likes,
             COALESCE(SUM(dislikes), 0) AS dislikes,
             MIN(message_date) AS oldestMessageDate,
             MAX(message_date) AS newestMessageDate,
             MAX(updated_at) AS lastUpdatedAt
      FROM posts
      WHERE chat_id = ?
    `,
    [chatId]
  );
  const recent = await repository.all(
    `
      SELECT COUNT(*) AS count, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes
      FROM posts
      WHERE chat_id = ? AND message_date >= ?
    `,
    [chatId, recentSinceIso]
  );
  const fresh = await repository.all(
    'SELECT COUNT(*) AS count FROM posts WHERE chat_id = ? AND message_date >= ?',
    [chatId, freshSinceIso]
  );
  const media = await repository.all(
    `
      SELECT
        COALESCE(SUM(CASE WHEN json_array_length(COALESCE(json_extract(data, '$.media'), json('[]'))) > 0 THEN 1 ELSE 0 END), 0) AS withMedia,
        COALESCE(SUM(CASE WHEN json_array_length(COALESCE(json_extract(data, '$.media'), json('[]'))) = 0 THEN 1 ELSE 0 END), 0) AS textOnly,
        COALESCE(SUM(json_array_length(COALESCE(json_extract(data, '$.media'), json('[]')))), 0) AS mediaItems
      FROM posts
      WHERE chat_id = ?
    `,
    [chatId]
  );
  const topAuthor = await repository.all(
    `
      SELECT author, COUNT(*) AS count, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes
      FROM posts
      WHERE chat_id = ? AND author IS NOT NULL AND author != ''
      GROUP BY author
      ORDER BY count DESC, (likes - dislikes) DESC, likes DESC
      LIMIT 1
    `,
    [chatId]
  );
  const authorCount = await repository.all(
    `
      SELECT COUNT(DISTINCT author) AS count
      FROM posts
      WHERE chat_id = ? AND author IS NOT NULL AND author != ''
    `,
    [chatId]
  );
  const publications = await repository.all(
    `
      SELECT status, COUNT(*) AS count
      FROM publications
      GROUP BY status
    `
  );
  const lastPublication = await repository.all(
    `
      SELECT id, key, status, finished_at AS finishedAt, updated_at AS updatedAt, last_error AS lastError
      FROM publications
      ORDER BY COALESCE(updated_at, finished_at, created_at) DESC, id DESC
      LIMIT 1
    `
  );
  const monthTop = await repository.getTopPosts({
    chatId,
    sinceIso: subtractMonths(now, 1).toISOString(),
    untilIso: now.toISOString(),
    limit: 1
  });

  return {
    total: normalizeRow(all[0]),
    recent: normalizeRow(recent[0]),
    freshCount: Number(fresh[0]?.count || 0),
    topPost: monthTop[0] || null,
    dateRange: {
      oldestMessageDate: all[0]?.oldestMessageDate || null,
      newestMessageDate: all[0]?.newestMessageDate || null,
      lastUpdatedAt: all[0]?.lastUpdatedAt || null
    },
    media: normalizeMediaRow(media[0]),
    topAuthor: normalizeAuthorRow(topAuthor[0]),
    uniqueAuthors: Number(authorCount[0]?.count || 0),
    publications: normalizePublicationRows(publications),
    lastPublication: lastPublication[0] || null,
    windows: {
      recentDays: config.sync.refreshRecentDays,
      recentSinceIso,
      freshSinceIso
    },
    settings: {
      sourceChatId: config.telegram.sourceChatId,
      retentionDays: config.sync.retentionDays,
      workerIntervalMinutes: config.publish.workerIntervalMinutes,
      dryRun: Boolean(config.publish.dryRun)
    }
  };
}

export function formatStats(stats, templates = {}) {
  const statsTemplates = templates.stats || {};
  const summaryTemplate = statsTemplates.summary || [
    'Database stats',
    'Total posts: {{totalCount}}',
    'Total reactions: 👍 {{totalLikes}}  👎 {{totalDislikes}}',
    'Fresh in 24h: {{freshCount}}',
    'Refresh window: {{recentCount}} posts, 👍 {{recentLikes}}  👎 {{recentDislikes}}'
  ].join('\n');
  const total = stats.total || {};
  const recent = stats.recent || {};
  const windows = stats.windows || {};
  const dateRange = stats.dateRange || {};
  const media = stats.media || {};
  const publications = stats.publications || {};
  const settings = stats.settings || {};
  const values = {
    totalCount: total.count || 0,
    totalLikes: total.likes || 0,
    totalDislikes: total.dislikes || 0,
    freshCount: stats.freshCount,
    recentCount: recent.count || 0,
    recentLikes: recent.likes || 0,
    recentDislikes: recent.dislikes || 0,
    recentDays: windows.recentDays || 0,
    oldestMessageDate: formatDate(dateRange.oldestMessageDate),
    newestMessageDate: formatDate(dateRange.newestMessageDate),
    lastUpdatedAt: formatDate(dateRange.lastUpdatedAt),
    mediaPosts: media.withMedia || 0,
    textOnlyPosts: media.textOnly || 0,
    mediaItems: media.mediaItems || 0,
    publicationCreated: publications.created || 0,
    publicationRunning: publications.running || 0,
    publicationPublished: publications.published || 0,
    publicationDryRun: publications.dry_run || 0,
    publicationFailed: publications.failed || 0,
    publicationCancelled: publications.cancelled || 0,
    sourceChatId: settings.sourceChatId || 'n/a',
    retentionDays: settings.retentionDays || 0,
    workerIntervalMinutes: settings.workerIntervalMinutes || 0,
    dryRun: settings.dryRun ? 'yes' : 'no',
    uniqueAuthors: stats.uniqueAuthors || 0
  };
  const lines = [renderTemplate(summaryTemplate, values)];
  const details = [
    `Source chat: ${values.sourceChatId}`,
    `Date range: ${values.oldestMessageDate} -> ${values.newestMessageDate}`,
    `Last DB update: ${values.lastUpdatedAt}`,
    `Media: ${values.mediaPosts} posts, ${values.mediaItems} items, ${values.textOnlyPosts} text-only`,
    `Authors: ${values.uniqueAuthors} unique`,
    `Settings: refresh ${values.recentDays}d, retention ${values.retentionDays}d, publish worker ${values.workerIntervalMinutes}m, dry-run ${values.dryRun}`,
    `Publications: created ${values.publicationCreated}, running ${values.publicationRunning}, published ${values.publicationPublished}, dry-run ${values.publicationDryRun}, failed ${values.publicationFailed}, cancelled ${values.publicationCancelled}`
  ];
  if (stats.topAuthor) {
    details.push(`Top author: ${stats.topAuthor.author} (${stats.topAuthor.count} posts, 👍 ${stats.topAuthor.likes}  👎 ${stats.topAuthor.dislikes})`);
  }
  if (stats.lastPublication) {
    details.push(`Last publication: #${stats.lastPublication.id} ${stats.lastPublication.status}${stats.lastPublication.key ? ` ${stats.lastPublication.key}` : ''}`);
    if (stats.lastPublication.lastError) details.push(`Last publication error: ${stats.lastPublication.lastError}`);
  }
  lines.push(details.join('\n'));

  if (stats.topPost) {
    lines.push(renderTemplate(statsTemplates.topPost || 'Top month post: #{{messageId}}, 👍 {{likes}}  👎 {{dislikes}}', {
      messageId: stats.topPost.messageId,
      likes: stats.topPost.likes,
      dislikes: stats.topPost.dislikes,
      score: (stats.topPost.likes || 0) - (stats.topPost.dislikes || 0)
    }));
  }

  return lines.join('\n');
}

function normalizeRow(row) {
  return {
    count: Number(row?.count || 0),
    likes: Number(row?.likes || 0),
    dislikes: Number(row?.dislikes || 0)
  };
}

function normalizeMediaRow(row) {
  return {
    withMedia: Number(row?.withMedia || 0),
    textOnly: Number(row?.textOnly || 0),
    mediaItems: Number(row?.mediaItems || 0)
  };
}

function normalizeAuthorRow(row) {
  if (!row) return null;
  return {
    author: row.author,
    count: Number(row.count || 0),
    likes: Number(row.likes || 0),
    dislikes: Number(row.dislikes || 0)
  };
}

function normalizePublicationRows(rows = []) {
  const stats = {
    created: 0,
    running: 0,
    published: 0,
    dry_run: 0,
    failed: 0,
    cancelled: 0
  };
  for (const row of rows) {
    stats[row.status] = Number(row.count || 0);
  }
  return stats;
}

function formatDate(value) {
  return value || 'n/a';
}
