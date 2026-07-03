import { deepMerge } from '../../config/index.js';
import { buildDraftConfig } from '../../core/setupConfig.js';
import { compileSourceWhere, getSourceDefinitions } from '../../core/sourceExpression.js';
import { setupScreen } from './formattingBase.js';

const DEFAULT_SOURCE_TEST_DAYS = 30;
const DEFAULT_SOURCE_TEST_EXAMPLES = 4;

export async function formatSourceExpressionTest({ repository, draft = {}, baseConfig = {}, days = DEFAULT_SOURCE_TEST_DAYS } = {}) {
  if (!repository?.all) {
    return setupScreen({
      icon: '🧮',
      title: 'Source expression test',
      sections: [
        ['⚠️ Unable to test', ['Repository is not available in this setup context.']],
        ['➡️ Next', ['Run this from the normal app/setup process with an initialized database.']]
      ]
    });
  }

  const config = deepMerge(baseConfig, buildDraftConfig(draft));
  const chatId = config.telegram?.sourceChatId;
  const sources = getSourceDefinitions(config);
  const sinceIso = new Date(Date.now() - Math.max(1, Number(days)) * 24 * 60 * 60 * 1000).toISOString();
  const total = await getTotalPosts(repository, chatId, sinceIso);
  const errors = [];
  const sourceLines = [];
  const exampleLines = [];

  for (const source of sources) {
    try {
      const whereSql = compileSourceWhere(source.where || 'true');
      const summary = await getSourceSummary(repository, { chatId, sinceIso, whereSql });
      const examples = await getSourceExamples(repository, { chatId, sinceIso, whereSql });
      const ratio = total > 0 ? Math.round(summary.count / total * 100) : 0;
      sourceLines.push(`- ${source.key}: ${summary.count}/${total} post(s), ${ratio}%, 👍 ${summary.likes}, 👎 ${summary.dislikes}; where=${source.where || 'true'}`);
      if (examples.length) {
        exampleLines.push(`${source.key}: ${examples.map(formatExample).join(' · ')}`);
      } else {
        exampleLines.push(`${source.key}: no examples matched.`);
      }
    } catch (error) {
      errors.push(`${source.key || '<missing key>'}: ${error.message}`);
    }
  }

  const warnings = [];
  if (total === 0) warnings.push(`No stored posts found for the last ${days} day(s). Run /backfill or /sync before trusting source counts.`);
  for (const line of sourceLines) {
    if (/ 0\//.test(line)) warnings.push(`Source ${line.match(/^- ([^:]+)/)?.[1] || '?'} matches no stored posts in the sample.`);
  }

  return setupScreen({
    icon: '🧮',
    title: 'Source expression test',
    sections: [
      ['🔎 Database sample', [`Stored posts from last ${days} day(s): ${total}.`, `Chat: ${chatId || '<missing sourceChatId>'}.`]],
      ['🧱 Sources', sourceLines.length ? sourceLines : ['- no publish sources configured']],
      ...(errors.length ? [['❌ Errors', errors.map((item) => `- ${item}`)]] : []),
      ...(warnings.length ? [['⚠️ Warnings', warnings.map((item) => `- ${item}`)]] : []),
      ['🧪 Examples', exampleLines.length ? exampleLines.map((item) => `- ${item}`) : ['- no matching examples']],
      ['➡️ Next', ['If a source matches too many/few posts, tune publish.sources[].where from Advanced JSON or update presets.']]
    ]
  });
}

async function getTotalPosts(repository, chatId, sinceIso) {
  const rows = await repository.all(
    'SELECT COUNT(*) AS count FROM posts WHERE chat_id = ? AND message_date >= ?',
    [String(chatId), sinceIso]
  );
  return Number(rows[0]?.count || 0);
}

async function getSourceSummary(repository, { chatId, sinceIso, whereSql }) {
  const rows = await repository.all(
    `
      SELECT COUNT(*) AS count,
             COALESCE(SUM(likes), 0) AS likes,
             COALESCE(SUM(dislikes), 0) AS dislikes
      FROM posts
      WHERE chat_id = ?
        AND message_date >= ?
        AND (${whereSql})
    `,
    [String(chatId), sinceIso]
  );
  return {
    count: Number(rows[0]?.count || 0),
    likes: Number(rows[0]?.likes || 0),
    dislikes: Number(rows[0]?.dislikes || 0)
  };
}

async function getSourceExamples(repository, { chatId, sinceIso, whereSql }) {
  return repository.all(
    `
      SELECT message_id AS messageId, likes, dislikes, message_date AS messageDate
      FROM posts
      WHERE chat_id = ?
        AND message_date >= ?
        AND (${whereSql})
      ORDER BY (likes + dislikes) DESC, likes DESC, message_date DESC, message_id DESC
      LIMIT ?
    `,
    [String(chatId), sinceIso, DEFAULT_SOURCE_TEST_EXAMPLES]
  );
}

function formatExample(row) {
  return `#${row.messageId} 👍${row.likes || 0}/👎${row.dislikes || 0}`;
}
