import fs from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase } from './sqliteDatabase.js';
import { getLogger } from '../core/logger.js';
import { runMigrations } from './migrations.js';

export class PostRepository {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = null;
    this.logger = getLogger('database');
  }

  async init() {
    this.db = openSqliteDatabase(this.dbPath);

    await withSqliteBusyRetry(() => this.db.run('PRAGMA busy_timeout = 5000'));
    await withSqliteBusyRetry(() => this.db.run('PRAGMA journal_mode = WAL'));
    await withSqliteBusyRetry(() => this.db.run('PRAGMA foreign_keys = ON'));
    await withSqliteBusyRetry(() => runMigrations(this.db, this.logger));
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

    return rows.map((row) => deserializePost(row, this.logger)).filter(Boolean);
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

    return rows.map((row) => deserializePost(row, this.logger)).filter(Boolean);
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

    return rows.map((row) => deserializePost(row, this.logger)).filter(Boolean);
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
               finished_at AS finishedAt, last_error AS lastError, last_error_code AS lastErrorCode,
               last_progress_at AS lastProgressAt, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, header_message_id AS headerMessageId, data
        FROM publications
        WHERE key = ?
        ORDER BY id DESC
        LIMIT 1
      `,
      [key]
    );
    return rows[0] ? deserializePublication(rows[0], this.logger) : null;
  }

  async getBlockingPublicationByKey(key) {
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, last_error_code AS lastErrorCode,
               last_progress_at AS lastProgressAt, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, header_message_id AS headerMessageId, data
        FROM publications
        WHERE key = ?
          AND status IN ('created', 'header_sending', 'header_delivered', 'running', 'uncertain', 'published')
        ORDER BY id DESC
        LIMIT 1
      `,
      [key]
    );
    return rows[0] ? deserializePublication(rows[0], this.logger) : null;
  }

  async getPublicationById(publicationId) {
    const rows = await this.all(
      `
        SELECT id, key, selection_key AS selectionKey, title, period_start AS periodStart, period_end AS periodEnd,
               status, created_at AS createdAt, updated_at AS updatedAt,
               finished_at AS finishedAt, last_error AS lastError, last_error_code AS lastErrorCode,
               last_progress_at AS lastProgressAt, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, header_message_id AS headerMessageId, data
        FROM publications
        WHERE id = ?
        LIMIT 1
      `,
      [publicationId]
    );
    return rows[0] ? deserializePublication(rows[0], this.logger) : null;
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
                 finished_at AS finishedAt, last_error AS lastError, last_error_code AS lastErrorCode,
               last_progress_at AS lastProgressAt, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, header_message_id AS headerMessageId, data
          FROM publications
          WHERE status IN ('running', 'header_delivered', 'header_sending', 'created')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)
          ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'header_delivered' THEN 1 WHEN 'header_sending' THEN 2 ELSE 3 END,
                   created_at ASC, id ASC
          LIMIT 1
        `,
        [nowIso, nowIso, ownerId]
      );
      const row = rows[0];
      if (!row) {
        await this.run('COMMIT');
        return null;
      }
      const claimed = await this.run(
        `UPDATE publications
         SET lease_owner = ?, lease_until = ?, updated_at = ?, next_attempt_at = NULL
         WHERE id = ? AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)`,
        [ownerId, leaseUntil, nowIso, row.id, nowIso, ownerId]
      );
      await this.run('COMMIT');
      return claimed.changes === 1
        ? deserializePublication({ ...row, leaseOwner: ownerId, leaseUntil }, this.logger)
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
               SUM(CASE WHEN pp.send_state = 'sent' THEN 1 ELSE 0 END) AS sentCount
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
               SUM(CASE WHEN pp.send_state = 'sent' THEN 1 ELSE 0 END) AS sentCount
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
      active: activeRows.map((row) => deserializePublicationJob(row, this.logger)).filter(Boolean),
      finished: finishedRows.map((row) => deserializePublicationJob(row, this.logger)).filter(Boolean)
    };
  }

  async listRecentPublications({ limit = 10 } = {}) {
    const rows = await this.all(
      `
        SELECT p.id, p.key, p.selection_key AS selectionKey, p.title,
               p.status, p.created_at AS createdAt, p.updated_at AS updatedAt,
               p.finished_at AS finishedAt, p.last_error AS lastError, p.data,
               SUM(CASE WHEN pp.send_state = 'sent' THEN 1 ELSE 0 END) AS sentCount
        FROM publications p
        LEFT JOIN publication_posts pp ON pp.publication_id = p.id
        GROUP BY p.id
        ORDER BY COALESCE(p.updated_at, p.finished_at, p.created_at) DESC, p.id DESC
        LIMIT ?
      `,
      [limit]
    );
    return rows.map((row) => deserializePublicationJob(row, this.logger)).filter(Boolean);
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
        WHERE (
            status = 'created' AND created_at < ?
          OR status IN ('header_sending', 'header_delivered', 'running') AND COALESCE(last_progress_at, updated_at, created_at) < ?
        )
          AND (lease_until IS NULL OR lease_until <= ?)
      `,
      [now, now, 'Publication request expired before processing', expiredBefore, expiredBefore, now]
    );
  }

  async markPublicationHeaderSending(publicationId, ownerId) {
    return this.updateClaimedPublication(
      publicationId,
      ownerId,
      "status = 'header_sending', last_error = NULL, last_error_code = NULL, last_progress_at = datetime('now')"
    );
  }

  async markPublicationHeaderDelivered(publicationId, ownerId, botMessageId = null) {
    const now = new Date().toISOString();
    const result = await this.run(
      `UPDATE publications
       SET status = 'header_delivered', header_message_id = ?, updated_at = ?, last_progress_at = ?,
           last_error = NULL, last_error_code = NULL
       WHERE id = ? AND lease_owner = ?`,
      [botMessageId, now, now, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async markPublicationRunning(publicationId, ownerId) {
    const now = new Date().toISOString();
    const result = await this.run(
      'UPDATE publications SET status = ?, updated_at = ?, last_progress_at = ?, last_error = NULL, last_error_code = NULL WHERE id = ? AND lease_owner = ?',
      ['running', now, now, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async renewPublicationLease(publicationId, ownerId, leaseMs = 900_000) {
    const now = new Date();
    const result = await this.run(
      'UPDATE publications SET lease_until = ? WHERE id = ? AND lease_owner = ?',
      [new Date(now.getTime() + Math.max(1, Number(leaseMs) || 900_000)).toISOString(), publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async markPublicationUncertain(publicationId, ownerId, error) {
    const now = new Date().toISOString();
    const result = await this.run(
      `UPDATE publications
       SET status = 'uncertain', updated_at = ?, last_progress_at = ?, last_error = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND lease_owner = ?`,
      [now, now, error?.message || String(error), getErrorCode(error), publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async finishPublication(publicationId, { status, posts, data = {}, ownerId = null }) {
    const now = new Date().toISOString();

    await this.run('BEGIN');
    try {
      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        const initialSendState = status === 'dry_run' ? 'sent' : 'pending';
        await this.run(
          `INSERT OR IGNORE INTO publication_posts (
             publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          [publicationId, String(post.chatId), post.messageId, index + 1, post.likes || 0, post.dislikes || 0, initialSendState]
        );
      }

      if (status === 'published') {
        const rows = await this.all(
          `SELECT COUNT(*) AS incompleteCount
           FROM publication_posts
           WHERE publication_id = ? AND send_state NOT IN ('sent', 'failed')`,
          [publicationId]
        );
        const incompleteCount = Number(rows[0]?.incompleteCount || 0);
        if (incompleteCount > 0) {
          const error = new Error(`Publication ${publicationId} cannot be marked published with ${incompleteCount} incomplete post(s)`);
          error.code = 'PUBLICATION_INCOMPLETE';
          throw error;
        }
      }

      const result = await this.run(
        `UPDATE publications SET status = ?, updated_at = ?, last_progress_at = ?, finished_at = ?,
                last_error = NULL, last_error_code = NULL, lease_owner = NULL, lease_until = NULL,
                next_attempt_at = NULL, data = ?
         WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
        [status, now, now, status === 'published' || status === 'dry_run' || status === 'failed' ? now : null,
          JSON.stringify(data), publicationId, ownerId, ownerId]
      );
      if (ownerId) assertClaimUpdated(result, publicationId, ownerId);
      await this.run('COMMIT');
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  async failPublication(publicationId, error, ownerId = null) {
    const result = await this.run(
      `UPDATE publications SET status = ?, updated_at = ?, last_progress_at = ?, finished_at = ?,
              last_error = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL, next_attempt_at = NULL
       WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
      ['failed', new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
        error?.message || String(error), getErrorCode(error), publicationId, ownerId, ownerId]
    );
    if (ownerId) assertClaimUpdated(result, publicationId, ownerId);
  }

  async updatePublicationError(publicationId, error, ownerId = null) {
    await this.run(
      `UPDATE publications SET updated_at = ?, last_error = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
      [new Date().toISOString(), error?.message || String(error), getErrorCode(error), publicationId, ownerId, ownerId]
    );
  }

  async listPublicationPosts(publicationId) {
    return this.all(
      `
        SELECT publication_id AS publicationId, chat_id AS chatId, message_id AS messageId, position,
               likes, dislikes, bot_message_id AS botMessageId, sent_at AS sentAt, send_state AS sendState,
               attempt_count AS attemptCount, last_error AS lastError, last_error_code AS lastErrorCode
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
               pp.attempt_count AS attemptCount,
               pp.last_error AS lastError,
               pp.last_error_code AS lastErrorCode,
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

  async markPublicationPostDelivered({ publicationId, post, position, botMessageId = null, ownerId = null }) {
    if (ownerId) await this.assertPublicationLease(publicationId, ownerId);
    await this.run(
      `INSERT INTO publication_posts (
         publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state, attempt_count, last_error, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delivered', 0, NULL, NULL)
       ON CONFLICT(publication_id, chat_id, message_id) DO UPDATE SET
         position = excluded.position,
         likes = excluded.likes,
         dislikes = excluded.dislikes,
         bot_message_id = excluded.bot_message_id,
         sent_at = excluded.sent_at,
         send_state = 'delivered',
         last_error = NULL,
         last_error_code = NULL`,
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
    await this.touchPublicationProgress(publicationId);
  }

  async markPublicationPostSent({ publicationId, post, position, botMessageId = null, ownerId = null }) {
    if (ownerId) await this.assertPublicationLease(publicationId, ownerId);
    const result = await this.run(
      `UPDATE publication_posts
       SET position = ?, likes = ?, dislikes = ?, bot_message_id = COALESCE(?, bot_message_id),
           sent_at = COALESCE(sent_at, ?), send_state = 'sent', last_error = NULL, last_error_code = NULL
       WHERE publication_id = ? AND chat_id = ? AND message_id = ? AND send_state IN ('delivered', 'sent')`,
      [position, post.likes || 0, post.dislikes || 0, botMessageId, new Date().toISOString(),
        publicationId, String(post.chatId), post.messageId]
    );
    if (result?.changes !== 1) {
      const error = new Error(`Publication post ${publicationId}:${post.chatId}:${post.messageId} is not in delivered state`);
      error.code = 'PUBLICATION_POST_NOT_DELIVERED';
      throw error;
    }
    await this.touchPublicationProgress(publicationId);
  }

  async recordPublicationPost(args) {
    await this.markPublicationPostDelivered(args);
    await this.markPublicationPostSent(args);
  }

  async markPublicationPostSending({ publicationId, post, position, ownerId = null }) {
    if (ownerId) await this.assertPublicationLease(publicationId, ownerId);
    await this.run(
      `INSERT INTO publication_posts (
         publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state, attempt_count, last_error, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'sending', 1, NULL, NULL)
       ON CONFLICT(publication_id, chat_id, message_id) DO UPDATE SET
         position = excluded.position,
         likes = excluded.likes,
         dislikes = excluded.dislikes,
         bot_message_id = NULL,
         sent_at = NULL,
         send_state = 'sending',
         attempt_count = publication_posts.attempt_count + 1,
         last_error = NULL,
         last_error_code = NULL`,
      [publicationId, String(post.chatId), post.messageId, position, post.likes || 0, post.dislikes || 0]
    );
  }

  async markPublicationPostFailed({ publicationId, post, position, error, ownerId = null }) {
    if (ownerId) await this.assertPublicationLease(publicationId, ownerId);
    await this.run(
      `INSERT INTO publication_posts (
         publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state, attempt_count, last_error, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'failed', 1, ?, ?)
       ON CONFLICT(publication_id, chat_id, message_id) DO UPDATE SET
         position = excluded.position,
         likes = excluded.likes,
         dislikes = excluded.dislikes,
         bot_message_id = NULL,
         sent_at = NULL,
         send_state = 'failed',
         last_error = excluded.last_error,
         last_error_code = excluded.last_error_code`,
      [publicationId, String(post.chatId), post.messageId, position, post.likes || 0, post.dislikes || 0, error?.message || String(error), getErrorCode(error)]
    );
    await this.touchPublicationProgress(publicationId);
  }


  async resetPublicationHeaderForRetry(publicationId, ownerId, error = null) {
    const now = new Date().toISOString();
    const result = await this.run(
      `UPDATE publications SET status = 'created', header_message_id = NULL, updated_at = ?, last_progress_at = ?, last_error = ?, last_error_code = ?
       WHERE id = ? AND lease_owner = ?`,
      [now, now, error ? error?.message || String(error) : null, error ? getErrorCode(error) : null, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async markPublicationPostPending({ publicationId, post, position, error, ownerId = null }) {
    if (ownerId) await this.assertPublicationLease(publicationId, ownerId);
    await this.run(
      `INSERT INTO publication_posts (
         publication_id, chat_id, message_id, position, likes, dislikes, bot_message_id, sent_at, send_state, attempt_count, last_error, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', 0, ?, ?)
       ON CONFLICT(publication_id, chat_id, message_id) DO UPDATE SET
         position = excluded.position,
         likes = excluded.likes,
         dislikes = excluded.dislikes,
         bot_message_id = NULL,
         sent_at = NULL,
         send_state = 'pending',
         last_error = excluded.last_error,
         last_error_code = excluded.last_error_code`,
      [publicationId, String(post.chatId), post.messageId, position, post.likes || 0, post.dislikes || 0, error?.message || String(error), getErrorCode(error)]
    );
  }

  async releasePublicationLease(publicationId, ownerId, error = null) {
    const result = await this.run(
      `UPDATE publications SET updated_at = ?, last_error = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND lease_owner = ?`,
      [new Date().toISOString(), error ? error?.message || String(error) : null, error ? getErrorCode(error) : null, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
  }

  async assertPublicationLease(publicationId, ownerId, now = new Date()) {
    const rows = await this.all(
      'SELECT lease_owner AS leaseOwner, lease_until AS leaseUntil FROM publications WHERE id = ? LIMIT 1',
      [publicationId]
    );
    const row = rows[0];
    if (!row || row.leaseOwner !== ownerId || !row.leaseUntil || new Date(row.leaseUntil) <= now) {
      const error = new Error(`Publication lease lost for publication ${publicationId}`);
      error.code = 'PUBLICATION_LEASE_LOST';
      error.publicationId = publicationId;
      error.ownerId = ownerId;
      throw error;
    }
    return true;
  }

  async deferPublicationRetry(publicationId, ownerId, error, {
    delayMs = 1000,
    maxAttempts = 3,
    countAttempt = true,
    status = null
  } = {}) {
    const now = new Date();
    const nowIso = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + Math.max(1, Number(delayMs) || 1000)).toISOString();
    const attemptIncrement = countAttempt ? 1 : 0;
    const result = await this.run(
      `UPDATE publications
       SET status = COALESCE(?, status), updated_at = ?, last_progress_at = ?, last_error = ?, last_error_code = ?,
           attempt_count = attempt_count + ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND lease_owner = ?`,
      [status, nowIso, nowIso, error?.message || String(error), getErrorCode(error), attemptIncrement,
        nextAttemptAt, publicationId, ownerId]
    );
    assertClaimUpdated(result, publicationId, ownerId);
    const rows = await this.all('SELECT attempt_count AS attemptCount FROM publications WHERE id = ?', [publicationId]);
    const attemptCount = Number(rows[0]?.attemptCount || 0);
    const boundedAttempts = Number.isFinite(Number(maxAttempts)) ? Math.max(0, Number(maxAttempts)) : null;
    if (countAttempt && boundedAttempts !== null && attemptCount > boundedAttempts) {
      await this.failPublication(publicationId, error);
      return { failed: true, attemptCount };
    }
    return { failed: false, attemptCount, nextAttemptAt };
  }

  async touchPublicationProgress(publicationId) {
    const now = new Date().toISOString();
    await this.run('UPDATE publications SET updated_at = ?, last_progress_at = ? WHERE id = ?', [now, now, publicationId]);
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

function deserializePost(row, logger) {
  const data = safeParseJson(row.data, { logger, entity: 'post', id: `${row.chatId}:${row.messageId}` });
  return data === null ? null : { ...row, data };
}

function deserializePublication(row, logger = null) {
  const data = safeParseJson(row.data, { logger, entity: 'publication', id: row.id });
  return data === null ? null : { ...row, data };
}

function deserializePublicationJob(row, logger = null) {
  const data = safeParseJson(row.data, { logger, entity: 'publication', id: row.id });
  if (data === null) return null;
  return {
    ...row,
    sentCount: Number(row.sentCount || 0),
    expectedCount: Number(data.count || data.selection?.posts?.length || 0),
    data
  };
}

function safeParseJson(value, { logger, entity, id }) {
  try {
    return JSON.parse(value || '{}');
  } catch (error) {
    logger?.error?.('Corrupted JSON row skipped', {
      entity,
      id,
      error: error?.message || String(error)
    });
    return null;
  }
}

function getErrorCode(error) {
  return String(error?.telegramFailureClass || error?.code || error?.name || 'ERROR');
}
