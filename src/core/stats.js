import { subtractDays, subtractHours, subtractMonths } from './date.js';
import { renderTemplate } from './format.js';

export async function buildStats(repository, config, now = new Date()) {
  const chatId = String(config.telegram.sourceChatId);
  const all = await repository.all(
    'SELECT COUNT(*) AS count, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes FROM posts WHERE chat_id = ?',
    [chatId]
  );
  const recent = await repository.all(
    `
      SELECT COUNT(*) AS count, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes
      FROM posts
      WHERE chat_id = ? AND message_date >= ?
    `,
    [chatId, subtractDays(now, config.sync.refreshRecentDays).toISOString()]
  );
  const fresh = await repository.all(
    'SELECT COUNT(*) AS count FROM posts WHERE chat_id = ? AND message_date >= ?',
    [chatId, subtractHours(now, 24).toISOString()]
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
    topPost: monthTop[0] || null
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
  const values = {
    totalCount: stats.total.count,
    totalLikes: stats.total.likes,
    totalDislikes: stats.total.dislikes,
    freshCount: stats.freshCount,
    recentCount: stats.recent.count,
    recentLikes: stats.recent.likes,
    recentDislikes: stats.recent.dislikes
  };
  const lines = [renderTemplate(summaryTemplate, values)];

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
