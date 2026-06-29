import { parseMessagesToPosts } from '../core/postParser.js';
import { subtractDays, subtractMonths } from '../core/date.js';

export class TelegramScanner {
  constructor({ client, repository, config }) {
    this.client = client;
    this.repository = repository;
    this.config = config;
  }

  async sync() {
    const now = new Date();
    const existingCount = await this.repository.all('SELECT COUNT(*) AS count FROM posts WHERE chat_id = ?', [
      String(this.config.telegram.sourceChatId)
    ]);
    const isInitial = existingCount[0].count === 0;
    const since = isInitial
      ? subtractMonths(now, this.config.sync.initialScanMonths)
      : subtractDays(now, this.config.sync.refreshRecentDays);

    const seenIds = await this.scanSince(since);
    await this.removeDeletedRecentPosts(subtractDays(now, this.config.sync.refreshRecentDays), seenIds);

    return { isInitial, since: since.toISOString(), seen: seenIds.size };
  }

  async scanSince(sinceDate) {
    const seenIds = new Set();
    let offset = undefined;

    while (true) {
      const history = await this.client.getHistory(this.config.telegram.sourceChatId, {
        limit: this.config.sync.pageSize,
        offset
      });

      const messages = [...history];
      if (messages.length === 0) break;

      const posts = parseMessagesToPosts(messages, {
        chatId: this.config.telegram.sourceChatId,
        targetUserId: this.config.telegram.targetUserId,
        sourceMode: this.config.sync.source?.mode,
        parsing: this.config.parsing
      });

      for (const post of posts) {
        if (new Date(post.messageDate) >= sinceDate) {
          await this.repository.upsertPost(post);
          seenIds.add(post.messageId);
        }
      }

      const oldest = messages[messages.length - 1];
      if (getMessageDate(oldest) < sinceDate || !history.next) break;
      offset = history.next;
    }

    return seenIds;
  }

  async previewRecent(limit = 30, draft = {}) {
    const messages = [];
    let offset = undefined;

    while (messages.length < limit) {
      const batchLimit = Math.min(this.config.sync.pageSize, limit - messages.length);
      const history = await this.client.getHistory(this.config.telegram.sourceChatId, {
        limit: batchLimit,
        offset
      });
      const batch = [...history];
      if (batch.length === 0) break;
      messages.push(...batch);
      if (!history.next) break;
      offset = history.next;
    }

    const posts = parseMessagesToPosts(messages, {
      chatId: this.config.telegram.sourceChatId,
      targetUserId: this.config.telegram.targetUserId,
      sourceMode: draft.sync?.source?.mode || this.config.sync.source?.mode,
      parsing: draft.parsing || this.config.parsing
    });

    return { scanned: messages.length, posts };
  }

  async removeDeletedRecentPosts(sinceDate, seenIds) {
    const ids = await this.repository.listPostIdsSince(this.config.telegram.sourceChatId, sinceDate.toISOString());
    for (const row of ids) {
      if (!seenIds.has(row.messageId)) {
        await this.repository.deletePost(this.config.telegram.sourceChatId, row.messageId);
      }
    }
  }
}

function getMessageDate(message) {
  if (message.date instanceof Date) return message.date;
  return new Date(Number(message.date) * 1000);
}
