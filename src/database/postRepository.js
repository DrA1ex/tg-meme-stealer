import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export class PostRepository {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = null;
  }

  async init() {
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    await withSqliteBusyRetry(() => this.db.run('PRAGMA busy_timeout = 5000'));
    await withSqliteBusyRetry(() => this.db.run('PRAGMA journal_mode = WAL'));
    await withSqliteBusyRetry(() => this.db.run('PRAGMA foreign_keys = ON'));
    await withSqliteBusyRetry(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        author TEXT,
        text TEXT,
        likes INTEGER NOT NULL DEFAULT 0,
        dislikes INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        message_date TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )
    `));
    await withSqliteBusyRetry(() => this.db.exec('CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(message_date)'));
    await withSqliteBusyRetry(() => this.db.exec('CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(likes, dislikes)'));
    await withSqliteBusyRetry(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT,
        selection_key TEXT NOT NULL,
        title TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        last_error TEXT,
        lease_owner TEXT,
        lease_until TEXT,
        data TEXT NOT NULL DEFAULT '{}'
      )
    `));
    await ensureColumn(this.db, 'publications', 'lease_owner', 'TEXT');
    await ensureColumn(this.db, 'publications', 'lease_until', 'TEXT');
    await withSqliteBusyRetry(() => this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_key_active_v2
      ON publications(key)
      WHERE key IS NOT NULL AND status IN ('created', 'header_sending', 'running', 'uncertain', 'published')
    `));
    await withSqliteBusyRetry(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS publication_posts (
        publication_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        likes INTEGER NOT NULL,
        dislikes INTEGER NOT NULL,
        bot_message_id INTEGER,
        sent_at TEXT,
        send_state TEXT NOT NULL DEFAULT 'sent',
        PRIMARY KEY (publication_id, chat_id, message_id),
        FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
      )
    `));
    await ensureColumn(this.db, 'publication_posts', 'send_state', "TEXT NOT NULL DEFAULT 'sent'");
  }

  async upsertPost(post) {
    const now = new Date().toISOString();
    await this.run(
      `
        INSERT INTO posts (
          chat_id, message_id, author, text, likes, dislikes, data, message_date, collected_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          author = excluded.author,
          text = excluded.text,
          likes = excluded.likes,
          dislikes = excluded.dislikes,
          data = excluded.data,
          message_date = excluded.message_date,
          updated_at = excluded.updated_at
      `,
      [
        String(post.chatId),
        post.messageId,
        post.author || '',
        post.text || '',
        post.likes || 0,
        post.dislikes || 0,
        JSON.stringify(post.data || {}),
        post.messageDate,
        now,
        now
      ]
    );
  }

  async deletePost(chatId, messageId) {
    await this.run('DELETE FROM posts WHERE chat_id = ? AND message_id = ?', [String(chatId), messageId]);
  }

  async deletePostsOlderThan(chatId, beforeIso) {
    const result = await this.run(
      'DELETE FROM posts WHERE chat_id = ? AND message_date < ?',
      [String(chatId), beforeIso]
    );
    return result.changes || 0;
  }

  async listPostIdsSince(chatId, sinceIso) {
    return this.all(
      'SELECT message_id AS messageId FROM posts WHERE chat_id = ? AND message_date >= ? ORDER BY message_id',
      [String(chatId), sinceIso]
    );
  }

  async getTopPosts({ chatId, sinceIso, untilIso, limit }) {
    const params = [String(chatId), sinceIso];
    let untilClause = '';
    if (untilIso) {
      untilClause = 'AND message_date < ?';
      params.push(untilIso);
    }
    params.push(limit);

    const rows = await this.all(
      `
        SELECT chat_id AS chatId, message_id AS messageId, author, text, likes, dislikes, data, message_date AS messageDate
        FROM posts
        WHERE chat_id = ? AND message_date >= ? ${untilClause}
        ORDER BY (likes - dislikes) DESC, likes DESC, message_date DESC
        LIMIT ?
      `,
      params
    );

    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data || '{}')
    }));
  }

  async getControversialPosts({ chatId, sinceIso, untilIso, limit }) {
    const params = [String(chatId), sinceIso];
    let untilClause = '';
    if (untilIso) {
      untilClause = 'AND message_date < ?';
      params.push(untilIso);
    }
    params.push(limit);

    const rows = await this.all(
      `
        SELECT chat_id AS chatId, message_id AS messageId, author, text, likes, dislikes, data, message_date AS messageDate
        FROM posts
        WHERE chat_id = ?
          AND message_date >= ?
          ${untilClause}
          AND (CASE WHEN likes > dislikes THEN likes ELSE dislikes END) > 0
        ORDER BY (likes + dislikes) DESC, ABS(likes - dislikes) ASC, message_date DESC
        LIMIT ?
      `,
      params
    );

    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data || '{}')
    }));
  }

  async getSelectionPosts({
    chatId,
    sinceIso,
    untilIso,
    sourceWhereSql = '1',
    reactionScoreSql = 'likes',
    posts = {},
    reactions = {}
  }) {
    const max = Math.max(0, Number(posts.max ?? 10));
    const target = Math.min(max, Math.max(0, Number(posts.target ?? max)));
    const min = Math.min(max, Math.max(0, Number(posts.min ?? target)));
    const reactionMin = Number(reactions.min ?? 0);
    const includeAbove = Number.isFinite(Number(reactions.includeAbove))
      ? Number(reactions.includeAbove)
      : Number.MAX_SAFE_INTEGER;
    if (max <= 0) return [];

    const params = [String(chatId), sinceIso];
    let untilClause = '';
    if (untilIso) {
      untilClause = 'AND message_date < ?';
      params.push(untilIso);
    }
    params.push(
      reactionMin,
      includeAbove,
      min,
      reactionMin,
      target,
      max,
      max,
      target,
      min,
      min,
      max
    );

    const rows = await this.all(
      `
        WITH candidates AS (
          SELECT chat_id AS chatId,
                 message_id AS messageId,
                 author,
                 text,
                 likes,
                 dislikes,
                 data,
                 message_date AS messageDate,
                 (${reactionScoreSql}) AS reactionScore
          FROM posts
          WHERE chat_id = ?
            AND message_date >= ?
            ${untilClause}
            AND (${sourceWhereSql})
        ),
        stats AS (
          SELECT COALESCE(SUM(CASE WHEN reactionScore >= ? THEN 1 ELSE 0 END), 0) AS passCount,
                 COALESCE(SUM(CASE WHEN reactionScore >= ? THEN 1 ELSE 0 END), 0) AS aboveCount
          FROM candidates
        ),
        ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   ORDER BY reactionScore DESC, messageDate DESC, messageId DESC
                 ) AS rowNumber
          FROM candidates
        )
        SELECT chatId, messageId, author, text, likes, dislikes, data, messageDate
        FROM ranked
        CROSS JOIN stats
        WHERE (
            passCount >= ?
            AND reactionScore >= ?
            AND rowNumber <= CASE
              WHEN max(?, aboveCount) > ? THEN ?
              ELSE max(?, aboveCount)
            END
          )
          OR (
            passCount < ?
            AND rowNumber <= ?
          )
        ORDER BY rowNumber
        LIMIT ?
      `,
      params
    );

    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data || '{}')
    }));
  }

  async createPublication({ selectionKey, title, periodStart, periodEnd, status, posts, data = {} }) {
    const now = new Date().toISOString();

    await this.run('BEGIN');
    try {
      const result = await this.run(
        `
          INSERT INTO publications (selection_key, title, period_start, period_end, status, created_at, updated_at, finished_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [selectionKey, title, periodStart, periodEnd, status, now, now, now, JSON.stringify(data)]
      );
      const publicationId = result.lastID;

      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        await this.run(
          `
            INSERT INTO publication_posts (publication_id, chat_id, message_id, position, likes, dislikes)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          [publicationId, String(post.chatId), post.messageId, index + 1, post.likes || 0, post.dislikes || 0]
        );
      }

      await this.run('COMMIT');
      return publicationId;
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  async tryCreatePublicationRequest({ key, selectionKey, title, periodStart, periodEnd, data = {} }) {
    const now = new Date().toISOString();
    try {
      const result = await this.run(
        `
          INSERT INTO publications (
            key, selection_key, title, period_start, period_end, status, created_at, updated_at, data
          )
          VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?)
        `,
        [key, selectionKey, title, periodStart, periodEnd, now, now, JSON.stringify(data)]
      );
      return result.lastID;
    } catch (error) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  }

  async getPublicationByKey(key) {
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, data
        FROM publications
        WHERE key = ?
        ORDER BY id DESC
        LIMIT 1
      `,
      [key]
    );
    return rows[0] ? deserializePublication(rows[0]) : null;
  }

  async getBlockingPublicationByKey(key) {
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, data
        FROM publications
        WHERE key = ?
          AND status IN ('created', 'header_sending', 'running', 'uncertain', 'published')
        ORDER BY id DESC
        LIMIT 1
      `,
      [key]
    );
    return rows[0] ? deserializePublication(rows[0]) : null;
  }

  async getPublicationById(publicationId) {
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, data
        FROM publications
        WHERE id = ?
        LIMIT 1
      `,
      [publicationId]
    );
    return rows[0] ? deserializePublication(rows[0]) : null;
  }

  async getNextPublicationRequest({ requestTtlHours = 12, ownerId = `pid:${process.pid}`, leaseMs = 900_000 } = {}) {
    await this.failExpiredPublicationRequests({ requestTtlHours });
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + Math.max(1, Number(leaseMs) || 900_000)).toISOString();
    await this.run('BEGIN IMMEDIATE');
    try {
      const rows = await this.all(
        `
          SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
                 status, created_at AS createdAt, updated_at AS updatedAt,
                 finished_at AS finishedAt, last_error AS lastError, data
          FROM publications
          WHERE status IN ('running', 'header_sending', 'created')
            AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)
          ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'header_sending' THEN 1 ELSE 2 END,
                   created_at ASC, id ASC
          LIMIT 1
        `,
        [nowIso, ownerId]
      );
      const row = rows[0];
      if (!row) {
        await this.run('COMMIT');
        return null;
      }
      const claimed = await this.run(
        `UPDATE publications
         SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)`,
        [ownerId, leaseUntil, nowIso, row.id, nowIso, ownerId]
      );
      await this.run('COMMIT');
      return claimed.changes === 1
        ? deserializePublication({ ...row, leaseOwner: ownerId, leaseUntil })
        : null;
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  async listPublicationJobs({ finishedLimit = 5 } = {}) {
    const activeRows = await this.all(
      `
        SELECT p.id, p.key, p.selection_key AS selectionKey, p.title,
               p.status, p.created_at AS createdAt, p.updated_at AS updatedAt,
               p.finished_at AS finishedAt, p.last_error AS lastError, p.data,
               COUNT(pp.message_id) AS sentCount
        FROM publications p
        LEFT JOIN publication_posts pp ON pp.publication_id = p.id
        WHERE p.status NOT IN ('published', 'dry_run', 'failed', 'cancelled')
        GROUP BY p.id
        ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC
      `
    );
    const finishedRows = await this.all(
      `
        SELECT p.id, p.key, p.selection_key AS selectionKey, p.title,
               p.status, p.created_at AS createdAt, p.updated_at AS updatedAt,
               p.finished_at AS finishedAt, p.last_error AS lastError, p.data,
               COUNT(pp.message_id) AS sentCount
        FROM publications p
        LEFT JOIN publication_posts pp ON pp.publication_id = p.id
        WHERE p.status IN ('published', 'dry_run', 'failed', 'cancelled')
        GROUP BY p.id
        ORDER BY COALESCE(p.updated_at, p.finished_at, p.created_at) DESC, p.id DESC
        LIMIT ?
      `,
      [finishedLimit]
    );

    return {
      active: activeRows.map(deserializePublicationJob),
      finished: finishedRows.map(deserializePublicationJob)
    };
  }

  async listRecentPublications({ limit = 10 } = {}) {
    const rows = await this.all(
      `
        SELECT p.id, p.key, p.selection_key AS selectionKey, p.title,
               p.status, p.created_at AS createdAt, p.updated_at AS updatedAt,
               p.finished_at AS finishedAt, p.last_error AS lastError, p.data,
               COUNT(pp.message_id) AS sentCount
        FROM publications p
        LEFT JOIN publication_posts pp ON pp.publication_id = p.id
        GROUP BY p.id
        ORDER BY COALESCE(p.updated_at, p.finished_at, p.created_at) DESC, p.id DESC
        LIMIT ?
      `,
      [limit]
    );
    return rows.map(deserializePublicationJob);
  }

  async failExpiredPublicationRequests({ requestTtlHours = 12 } = {}) {
    const expiredBefore = new Date(Date.now() - Math.max(1, Number(requestTtlHours)) * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await this.run(
      `
        UPDATE publications
        SET status = 'failed',
            updated_at = ?,
            finished_at = ?,
            last_error = ?,
            lease_owner = NULL,
            lease_until = NULL
        WHERE status IN ('created', 'header_sending', 'running')
          AND created_at < ?
          AND (lease_until IS NULL OR lease_until <= ?)
      `,
      [now, now, 'Publication request expired before processing', expiredBefore, now]
    );
  }

  async markPublicationHeaderSending(publicationId, ownerId) {
    return this.updateClaimedPublication(
      publicationId,
      ownerId,
      "status = 'header_sending', last_error = NULL"
    );
  }

  async markPublicationRunning(publicationId, ownerId) {
    const now = new Date().toISOString();
    const result = await this.run(
      'UPDATE publications SET status = ?, updated_at = ?, last_error = NULL WHERE id = ? AND lease_owner = ?',
      ['running', now, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async renewPublicationLease(publicationId, ownerId, leaseMs = 900_000) {
    const now = new Date();
    const result = await this.run(
      'UPDATE publications SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ?',
      [new Date(now.getTime() + Math.max(1, Number(leaseMs) || 900_000)).toISOString(), now.toISOString(), publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async markPublicationUncertain(publicationId, ownerId, error) {
    const now = new Date().toISOString();
    const result = await this.run(
      `UPDATE publications
       SET status = 'uncertain', updated_at = ?, last_error = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND lease_owner = ?`,
      [now, error?.message || String(error), publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async finishPublication(publicationId, { status, posts, data = {} }) {
    const now = new Date().toISOString();

    await this.run('BEGIN');
    try {
      await this.run(
        'UPDATE publications SET status = ?, updated_at = ?, finished_at = ?, last_error = NULL, lease_owner = NULL, lease_until = NULL, data = ? WHERE id = ?',
        [status, now, status === 'published' || status === 'dry_run' || status === 'failed' ? now : null, JSON.stringify(data), publicationId]
      );

      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        await this.run(
          `
            INSERT OR IGNORE INTO publication_posts (
              publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [publicationId, String(post.chatId), post.messageId, index + 1, post.likes || 0, post.dislikes || 0, null, null]
        );
      }

      await this.run('COMMIT');
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  async failPublication(publicationId, error) {
    await this.run(
      'UPDATE publications SET status = ?, updated_at = ?, finished_at = ?, last_error = ?, lease_owner = NULL, lease_until = NULL WHERE id = ?',
      ['failed', new Date().toISOString(), new Date().toISOString(), error?.message || String(error), publicationId]
    );
  }

  async updatePublicationError(publicationId, error, ownerId = null) {
    await this.run(
      `UPDATE publications SET updated_at = ?, last_error = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
      [new Date().toISOString(), error?.message || String(error), publicationId, ownerId, ownerId]
    );
  }

  async listPublicationPosts(publicationId) {
    return this.all(
      `
        SELECT publication_id AS publicationId, chat_id AS chatId, message_id AS messageId, position,
               likes, dislikes, bot_message_id AS botMessageId, sent_at AS sentAt, send_state AS sendState
        FROM publication_posts
        WHERE publication_id = ?
        ORDER BY position ASC
      `,
      [publicationId]
    );
  }

  async listPublicationPostsDetailed(publicationId) {
    return this.all(
      `
        SELECT pp.publication_id AS publicationId,
               pp.chat_id AS chatId,
               pp.message_id AS messageId,
               pp.position,
               pp.likes,
               pp.dislikes,
               pp.bot_message_id AS botMessageId,
               pp.sent_at AS sentAt,
               pp.send_state AS sendState,
               posts.author,
               posts.text,
               posts.message_date AS messageDate
        FROM publication_posts pp
        LEFT JOIN posts
          ON posts.chat_id = pp.chat_id
         AND posts.message_id = pp.message_id
        WHERE pp.publication_id = ?
        ORDER BY pp.position ASC
      `,
      [publicationId]
    );
  }

  async recordPublicationPost({ publicationId, post, position, botMessageId = null }) {
    await this.run(
      `
        INSERT OR REPLACE INTO publication_posts (
          publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
      `,
      [
        publicationId,
        String(post.chatId),
        post.messageId,
        position,
        post.likes || 0,
        post.dislikes || 0,
        botMessageId,
        new Date().toISOString()
      ]
    );
  }

  async markPublicationPostSending({ publicationId, post, position }) {
    await this.run(
      `INSERT INTO publication_posts (
         publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'sending')
       ON CONFLICT(publication_id, chat_id, message_id) DO UPDATE SET
         position = excluded.position,
         likes = excluded.likes,
         dislikes = excluded.dislikes,
         bot_message_id = NULL,
         sent_at = NULL,
         send_state = 'sending'`,
      [publicationId, String(post.chatId), post.messageId, position, post.likes || 0, post.dislikes || 0]
    );
  }

  async updateClaimedPublication(publicationId, ownerId, assignments) {
    const result = await this.run(
      `UPDATE publications SET ${assignments}, updated_at = ? WHERE id = ? AND lease_owner = ?`,
      [new Date().toISOString(), publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async run(sql, params = []) {
    return this.db.run(sql, params);
  }

  async all(sql, params = []) {
    return this.db.all(sql, params);
  }

  async close() {
    if (this.db) await this.db.close();
  }
}

function isUniqueConstraintError(error) {
  return error?.code === 'SQLITE_CONSTRAINT' || /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(String(error?.message || error));
}

async function ensureColumn(db, table, column, definition) {
  const columns = await withSqliteBusyRetry(() => db.all(`PRAGMA table_info(${table})`));
  if (columns.some((item) => item.name === column)) return;
  try {
    await withSqliteBusyRetry(() => db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  } catch (error) {
    if (/duplicate column name/i.test(String(error?.message || error))) return;
    throw error;
  }
}

async function withSqliteBusyRetry(operation, maxAttempts = 10) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error?.code !== 'SQLITE_BUSY' || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
  throw lastError;
}

function assertClaimUpdated(result, publicationId, ownerId) {
  if (result?.changes === 1) return;
  const error = new Error(`Publication ${publicationId} lease is no longer owned by ${ownerId}`);
  error.code = 'PUBLICATION_LEASE_LOST';
  throw error;
}

function deserializePublication(row) {
  return {
    ...row,
    data: JSON.parse(row.data || '{}')
  };
}

function deserializePublicationJob(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    ...row,
    sentCount: Number(row.sentCount || 0),
    expectedCount: Number(data.count || data.selection?.posts?.length || 0),
    data
  };
}
