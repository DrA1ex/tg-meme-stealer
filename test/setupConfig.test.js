import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  selectWeekPreviewPost,
  setParsingRules,
  setSourceMode,
  summarizeParsedPosts
} from '../src/core/setupConfig.js';

test('setup draft keeps only source and parsing config', () => {
  const draft = createSetupDraft({
    sync: { source: { mode: 'user' }, pageSize: 100 },
    parsing: { filters: [{ transform: 'hasContent' }] },
    telegram: { botToken: 'secret' }
  });

  assert.deepEqual(draft, {
    sync: { source: { mode: 'user' } },
    parsing: { filters: [{ transform: 'hasContent' }] }
  });
});

test('setup helpers update mode and parser rules', () => {
  const draft = createSetupDraft({ sync: { source: { mode: 'user' } }, parsing: {} });

  setSourceMode(draft, 'all');
  setParsingRules(draft, 'likes', { path: 'a', transform: 'count' });
  addParsingRule(draft, 'likes', { path: 'b', transform: 'count' });

  assert.equal(draft.sync.source.mode, 'all');
  assert.deepEqual(draft.parsing.likes, [
    { path: 'a', transform: 'count' },
    { path: 'b', transform: 'count' }
  ]);
});

test('parseJsonArgument reads JSON after command', () => {
  assert.deepEqual(parseJsonArgument('/setfilter@bot {"source":"message"}'), { source: 'message' });
});

test('formatDraftConfig returns final config snippet', () => {
  const draft = createSetupDraft({ sync: { source: { mode: 'all' } }, parsing: { filters: [] } });
  const parsed = JSON.parse(formatDraftConfig(draft));

  assert.deepEqual(parsed, {
    sync: { source: { mode: 'all' } },
    parsing: { filters: [] }
  });
});

test('summarizeParsedPosts and preview select best weekly post', () => {
  const posts = [
    post({ messageId: 1, likes: 10, dislikes: 0, daysAgo: 1 }),
    post({ messageId: 2, likes: 20, dislikes: 15, daysAgo: 1 }),
    post({ messageId: 3, likes: 100, dislikes: 0, daysAgo: 10 })
  ];
  const summary = summarizeParsedPosts({ scanned: 30, posts });
  const preview = selectWeekPreviewPost(posts, new Date('2026-06-29T00:00:00.000Z'));

  assert.match(summary, /Scanned messages: 30/);
  assert.equal(preview.messageId, 1);
  assert.match(formatPreviewPost(preview), /👍 10/);
});

function post({ messageId, likes, dislikes, daysAgo }) {
  const now = new Date('2026-06-29T00:00:00.000Z');
  return {
    chatId: -1001,
    messageId,
    author: 'Alice',
    text: 'By Alice',
    likes,
    dislikes,
    messageDate: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    data: { media: [{ mediaKind: 'photo' }] }
  };
}
