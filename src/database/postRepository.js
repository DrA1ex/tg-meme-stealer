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
        selection_key TEXT NOT NULL,
        title TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}'
      )
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS publication_posts (
        publication_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        likes INTEGER NOT NULL,
        dislikes INTEGER NOT NULL,
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
    const publishedAt = new Date().toISOString();

    await this.run('BEGIN');
    try {
      const result = await this.run(
        `
          INSERT INTO publications (selection_key, title, period_start, period_end, status, published_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [selectionKey, title, periodStart, periodEnd, status, publishedAt, JSON.stringify(data)]
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
