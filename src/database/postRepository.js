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

    await this.db.run('PRAGMA journal_mode = WAL');
    await this.db.run('PRAGMA foreign_keys = ON');
    await this.db.exec(`
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
    `);
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(message_date)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(likes, dislikes)');
    await this.db.exec(`
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
        data TEXT NOT NULL DEFAULT '{}'
      )
    `);
    await this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_key_active
      ON publications(key)
      WHERE key IS NOT NULL AND status IN ('created', 'running', 'published')
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS publication_posts (
        publication_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        likes INTEGER NOT NULL,
        dislikes INTEGER NOT NULL,
        bot_message_id INTEGER,
        sent_at TEXT,
        PRIMARY KEY (publication_id, chat_id, message_id),
        FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
      )
    `);
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

  async getControversialPosts({ chatId, sinceIso, untilIso, limit, threshold }) {
    const params = [String(chatId), sinceIso];
    let untilClause = '';
    if (untilIso) {
      untilClause = 'AND message_date < ?';
      params.push(untilIso);
    }
    params.push(threshold, limit);

    const rows = await this.all(
      `
        SELECT chat_id AS chatId, message_id AS messageId, author, text, likes, dislikes, data, message_date AS messageDate
        FROM posts
        WHERE chat_id = ?
          AND message_date >= ?
          ${untilClause}
          AND (CASE WHEN likes > dislikes THEN likes ELSE dislikes END) > 0
          AND ABS(likes - dislikes) <= (CASE WHEN likes > dislikes THEN likes ELSE dislikes END) * ?
        ORDER BY (CASE WHEN likes > dislikes THEN likes ELSE dislikes END) DESC, message_date DESC
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
          AND status IN ('created', 'running', 'published')
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

  async getNextPublicationRequest({ requestTtlHours = 12 } = {}) {
    await this.failExpiredPublicationRequests({ requestTtlHours });
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, data
        FROM publications
        WHERE status IN ('running', 'created')
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC, id ASC
        LIMIT 1
      `
    );
    return rows[0] ? deserializePublication(rows[0]) : null;
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
    await this.run(
      `
        UPDATE publications
        SET status = 'failed',
            updated_at = ?,
            finished_at = ?,
            last_error = ?
        WHERE status IN ('created', 'running')
          AND created_at < ?
      `,
      [new Date().toISOString(), new Date().toISOString(), 'Publication request expired before processing', expiredBefore]
    );
  }

  async markPublicationRunning(publicationId) {
    const now = new Date().toISOString();
    await this.run(
      'UPDATE publications SET status = ?, updated_at = ?, last_error = NULL WHERE id = ?',
      ['running', now, publicationId]
    );
  }

  async finishPublication(publicationId, { status, posts, data = {} }) {
    const now = new Date().toISOString();

    await this.run('BEGIN');
    try {
      await this.run(
        'UPDATE publications SET status = ?, updated_at = ?, finished_at = ?, last_error = NULL, data = ? WHERE id = ?',
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
      'UPDATE publications SET status = ?, updated_at = ?, finished_at = ?, last_error = ? WHERE id = ?',
      ['failed', new Date().toISOString(), new Date().toISOString(), error?.message || String(error), publicationId]
    );
  }

  async updatePublicationError(publicationId, error) {
    await this.run(
      'UPDATE publications SET updated_at = ?, last_error = ? WHERE id = ?',
      [new Date().toISOString(), error?.message || String(error), publicationId]
    );
  }

  async listPublicationPosts(publicationId) {
    return this.all(
      `
        SELECT publication_id AS publicationId, chat_id AS chatId, message_id AS messageId, position,
               likes, dislikes, bot_message_id AS botMessageId, sent_at AS sentAt
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
          publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
