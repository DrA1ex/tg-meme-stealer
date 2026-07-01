import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStats } from '../src/core/stats.js';

test('formatStats renders admin summary', () => {
  const text = formatStats({
    total: { count: 12, likes: 100, dislikes: 9 },
    recent: { count: 3, likes: 20, dislikes: 1 },
    freshCount: 2,
    topPost: { messageId: 99, likes: 50, dislikes: 4 },
    dateRange: {
      oldestMessageDate: '2026-06-01T00:00:00.000Z',
      newestMessageDate: '2026-07-01T00:00:00.000Z',
      lastUpdatedAt: '2026-07-01T01:00:00.000Z'
    },
    media: { withMedia: 8, textOnly: 4, mediaItems: 11 },
    uniqueAuthors: 3,
    settings: {
      sourceChatId: -1001,
      retentionDays: 60,
      workerIntervalMinutes: 10,
      dryRun: true
    },
    windows: { recentDays: 7 },
    publications: { created: 1, running: 0, published: 5, dry_run: 0, failed: 2, cancelled: 0 },
    topAuthor: { author: 'Alice', count: 4, likes: 40, dislikes: 3 },
    lastPublication: { id: 7, status: 'failed', key: 'publish:best.day:2026-07-01', lastError: 'network' }
  });

  assert.match(text, /Total posts: 12/);
  assert.match(text, /Fresh in 24h: 2/);
  assert.match(text, /Source chat: -1001/);
  assert.match(text, /Date range: 2026-06-01T00:00:00.000Z -> 2026-07-01T00:00:00.000Z/);
  assert.match(text, /Media: 8 posts, 11 items, 4 text-only/);
  assert.match(text, /Authors: 3 unique/);
  assert.match(text, /Settings: refresh 7d, retention 60d, publish worker 10m, dry-run yes/);
  assert.match(text, /Publications: created 1, running 0, published 5, dry-run 0, failed 2, cancelled 0/);
  assert.match(text, /Top author: Alice \(4 posts, 👍 40  👎 3\)/);
  assert.match(text, /Last publication: #7 failed publish:best.day:2026-07-01/);
  assert.match(text, /Last publication error: network/);
  assert.match(text, /Top month post: #99/);
});
