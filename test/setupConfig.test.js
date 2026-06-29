import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPost,
  selectWeekPreviewPosts,
  setParsingRules,
  setSourceMode,
  setTemplateValue,
  summarizeParsedPosts
} from '../src/core/setupConfig.js';

test('setup draft keeps only source and parsing config', () => {
  const draft = createSetupDraft({
    sync: { source: { mode: 'user' }, pageSize: 100 },
    parsing: { filters: [{ transform: 'hasContent' }] },
    telegram: { botToken: 'secret' }
  });

  assert.deepEqual(draft.sync, { source: { mode: 'user' } });
  assert.deepEqual(draft.parsing, { filters: [{ transform: 'hasContent' }] });
  assert.deepEqual(draft.templates, {});
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
    parsing: { filters: [] },
    templates: {}
  });
});

test('setup helpers update publish templates', () => {
  const draft = createSetupDraft({ sync: { source: { mode: 'user' } }, parsing: {}, templates: {} });

  setTemplateValue(draft, 'postCaption', 'Post {{messageId}} by {{author}}');
  setTemplateValue(draft, 'title.week', 'Weekly best');
  setTemplateValue(draft, 'unknownAuthor', 'anonymous');
  setTemplateValue(draft, 'maxTextLength', '120');
  setTemplateValue(draft, 'stats.summary', 'Stats {{totalCount}}');

  assert.equal(draft.templates.publish.postCaption, 'Post {{messageId}} by {{author}}');
  assert.equal(draft.templates.publish.selectionTitles.week, 'Weekly best');
  assert.equal(draft.templates.publish.unknownAuthor, 'anonymous');
  assert.equal(draft.templates.publish.maxTextLength, 120);
  assert.equal(draft.templates.stats.summary, 'Stats {{totalCount}}');
});

test('summarizeParsedPosts and preview select best weekly post', () => {
  const posts = [
    post({ messageId: 1, likes: 10, dislikes: 0, daysAgo: 1 }),
    post({ messageId: 2, likes: 20, dislikes: 15, daysAgo: 1 }),
    post({ messageId: 3, likes: 100, dislikes: 0, daysAgo: 10 }),
    post({ messageId: 4, likes: 2, dislikes: 0, daysAgo: 1 }),
    post({ messageId: 5, likes: 3, dislikes: 0, daysAgo: 1 }),
    post({ messageId: 6, likes: 4, dislikes: 0, daysAgo: 1 })
  ];
  const summary = summarizeParsedPosts({ scanned: 30, posts });
  const preview = selectWeekPreviewPost(posts, new Date('2026-06-29T00:00:00.000Z'));
  const previews = selectWeekPreviewPosts(posts, 3, new Date('2026-06-29T00:00:00.000Z'));

  assert.match(summary, /Scanned messages: 30/);
  assert.match(summary, /Matched posts: 6/);
  assert.match(summary, /Shown rows: 6/);
  assert.match(summary, /# \| id \| author \| likes \| dislikes \| media \| text/);
  assert.match(summary, /6 \| 6 \| Alice/);
  assert.equal(preview.messageId, 1);
  assert.deepEqual(previews.map((post) => post.messageId), [1, 2, 6]);
  const rendered = formatPreviewPost(preview, {
    publish: {
      postCaption: 'Post {{messageId}} by {{author}} score={{score}}'
    }
  });
  assert.match(rendered, /Post 1 by Alice score=10/);
  assert.match(rendered, /Media: 1 item\(s\): photo#1/);
});

test('saveDraftConfig creates config when missing', async () => {
  const dir = await fs.mkdtemp('/private/tmp/tg-memes-config-');
  const configPath = path.join(dir, 'config.json');
  const draft = createSetupDraft({ sync: { source: { mode: 'all' } }, parsing: { filters: [] }, templates: {} });

  const result = await saveDraftConfig(draft, configPath);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.sync.source, { mode: 'all' });
  await assert.rejects(fs.access(`${configPath}.old`));
});

test('saveDraftConfig backs up and deep-merges existing config', async () => {
  const dir = await fs.mkdtemp('/private/tmp/tg-memes-config-');
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ publish: { dryRun: true }, sync: { pageSize: 50 } }, null, 2));
  const draft = createSetupDraft({ sync: { source: { mode: 'user' } }, parsing: { filters: [] }, templates: {} });

  await saveDraftConfig(draft, configPath);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const backup = JSON.parse(await fs.readFile(`${configPath}.old`, 'utf8'));

  assert.equal(saved.publish.dryRun, true);
  assert.equal(saved.sync.pageSize, 50);
  assert.deepEqual(saved.sync.source, { mode: 'user' });
  assert.deepEqual(backup, { publish: { dryRun: true }, sync: { pageSize: 50 } });
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
    data: { media: [{ mediaKind: 'photo', messageId }] }
  };
}
