import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStats } from '../src/core/stats.js';

test('formatStats renders admin summary', () => {
  const text = formatStats({
    total: { count: 12, likes: 100, dislikes: 9 },
    recent: { count: 3, likes: 20, dislikes: 1 },
    freshCount: 2,
    topPost: { messageId: 99, likes: 50, dislikes: 4 }
  });

  assert.match(text, /Total posts: 12/);
  assert.match(text, /Fresh in 24h: 2/);
  assert.match(text, /Top month post: #99/);
});
