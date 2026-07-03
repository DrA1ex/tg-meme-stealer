import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPost,
  selectWeekPreviewPosts,
  setPublishSources,
  setPublishTemplate,
  upsertPublishSource,
  setParsingRules,
  setTemplateValue,
  summarizeParsedPosts,
  validateSetupDraft
} from '../src/core/setupConfig.js';

test('setup draft keeps editable publish, parsing and template config', () => {
  const draft = createSetupDraft({
    sync: { pageSize: 100 },
    publish: { dryRun: false, template: [{ source: 'best', key: 'week', template: 'Best week' }] },
    parsing: { filters: [{ transform: 'hasContent' }] },
    telegram: { botToken: 'secret' }
  });

  assert.equal(draft.sync, undefined);
  assert.deepEqual(draft.publish, { dryRun: false, template: [{ source: 'best', key: 'week', template: 'Best week' }] });
  assert.deepEqual(draft.parsing, { filters: [{ transform: 'hasContent' }] });
  assert.deepEqual(draft.templates, {});
});

test('setup helpers update parser rules', () => {
  const draft = createSetupDraft({ parsing: {} });

  setParsingRules(draft, 'likes', { path: 'a', transform: 'count' });
  addParsingRule(draft, 'likes', { path: 'b', transform: 'count' });

  assert.deepEqual(draft.parsing.likes, [
    { path: 'a', transform: 'count' },
    { path: 'b', transform: 'count' }
  ]);
});

test('parseJsonArgument reads JSON after command', () => {
  assert.deepEqual(parseJsonArgument('/setfilter@bot {"source":"message"}'), { source: 'message' });
});

test('formatDraftConfig returns final config snippet', () => {
  const draft = createSetupDraft({ parsing: { filters: [] }, publish: { dryRun: false } });
  const parsed = JSON.parse(formatDraftConfig(draft));

  assert.deepEqual(parsed, {
    publish: { dryRun: false },
    parsing: { filters: [] },
    templates: {}
  });
});

test('setup helpers update publish templates', () => {
  const draft = createSetupDraft({ parsing: {}, templates: {} });

  setTemplateValue(draft, 'templates.publish.postCaption', 'Post {{messageId}} by {{author}}');
  setTemplateValue(draft, 'publish.template.weekly_best.template', 'Weekly best {{count}}');
  setTemplateValue(draft, 'publish.template.weekly_controversial.template', 'Controversial {{count}}');
  setTemplateValue(draft, 'templates.publish.unknownAuthor', 'anonymous');
  setTemplateValue(draft, 'templates.publish.maxTextLength', '120');
  setTemplateValue(draft, 'templates.stats.summary', 'Stats {{totalCount}}');

  assert.equal(draft.templates.publish.postCaption, 'Post {{messageId}} by {{author}}');
  assert.deepEqual(draft.publish.template, [
    { key: 'weekly_best', template: 'Weekly best {{count}}' },
    { key: 'weekly_controversial', template: 'Controversial {{count}}' }
  ]);
  assert.equal(draft.templates.publish.unknownAuthor, 'anonymous');
  assert.equal(draft.templates.publish.maxTextLength, 120);
  assert.equal(draft.templates.stats.summary, 'Stats {{totalCount}}');
});

test('setTemplateValue rejects non-config publish template paths', () => {
  const draft = createSetupDraft({ parsing: {}, templates: {} });

  assert.throws(
    () => setTemplateValue(draft, 'publish.weekly_best.template', 'Weekly best {{count}}'),
    /Unknown template key: publish\.weekly_best\.template/
  );
});

test('setup helpers update publish sources and full publish template entries', () => {
  const draft = createSetupDraft({
    publish: {
      sources: [{ key: 'best', where: 'true' }],
      template: [
        publishTemplate({ key: 'daily_best', source: 'best', template: 'Old {{count}}' })
      ]
    }
  });

  setPublishSources(draft, [
    { key: 'best', where: 'likes >= 0' },
    { key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.3' }
  ]);
  upsertPublishSource(draft, { key: 'best', where: 'likes > dislikes' });
  setPublishTemplate(draft, {
    key: 'daily_best',
    posts: { target: 3, max: 5 },
    template: 'Fresh {{count}}'
  });
  setPublishTemplate(draft, publishTemplate({ key: 'daily_controversial', source: 'controversial', template: 'Controversial {{count}}' }));

  assert.deepEqual(draft.publish.sources, [
    { key: 'best', where: 'likes > dislikes' },
    { key: 'controversial', where: 'abs(likes - dislikes) < max(likes, dislikes) * 0.3' }
  ]);
  assert.deepEqual(draft.publish.template, [
    publishTemplate({
      key: 'daily_best',
      source: 'best',
      posts: { min: 1, target: 3, max: 5 },
      template: 'Fresh {{count}}'
    }),
    publishTemplate({ key: 'daily_controversial', source: 'controversial', template: 'Controversial {{count}}' })
  ]);
});

test('validateSetupDraft validates the merged new-format config before save', () => {
  const baseConfig = validSetupBaseConfig();
  const draft = createSetupDraft(baseConfig);

  setPublishTemplate(draft, {
    key: 'daily_best',
    schedule: { type: 'daily', time: '25:00' }
  });

  assert.throws(
    () => validateSetupDraft(draft, baseConfig),
    /publish\.template\.0\.schedule\.time: expected HH:mm/
  );
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
  assert.match(summary, / # \| id \| author \| likes \| dislikes \| media \| text/);
  assert.match(summary, / 6 \| 6  \| Alice/);
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-config-'));
  const configPath = path.join(dir, 'config.json');
  const draft = createSetupDraft({ parsing: { filters: [] }, templates: {} });

  const result = await saveDraftConfig(draft, configPath);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.parsing, { filters: [] });
  await assert.rejects(fs.access(`${configPath}.old`));
});

test('saveDraftConfig backs up and deep-merges existing config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-config-'));
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ publish: { dryRun: true }, sync: { pageSize: 50 } }, null, 2));
  const draft = createSetupDraft({ parsing: { filters: [] }, templates: {} });

  await saveDraftConfig(draft, configPath);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const backup = JSON.parse(await fs.readFile(`${configPath}.old`, 'utf8'));

  assert.equal(saved.publish.dryRun, true);
  assert.equal(saved.sync.pageSize, 50);
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

function publishTemplate(overrides = {}) {
  return {
    source: 'best',
    key: 'daily_best',
    enabled: true,
    schedule: { type: 'daily', time: '10:00' },
    windowHours: 24,
    posts: { min: 1, target: 5, max: 5 },
    reactions: { strategy: 'likes', min: 0, includeAbove: 999999 },
    template: 'Daily {{count}}',
    ...overrides,
    posts: {
      min: 1,
      target: 5,
      max: 5,
      ...overrides.posts
    },
    reactions: {
      strategy: 'likes',
      min: 0,
      includeAbove: 999999,
      ...overrides.reactions
    }
  };
}

function validSetupBaseConfig() {
  return {
    telegram: {
      apiId: 123,
      apiHash: 'hash',
      sessionFile: 'sessions/user.session',
      sourceChatId: -1001,
      adminId: 99,
      publishChannelId: -1002,
      botToken: 'token'
    },
    database: { path: 'data/posts.sqlite' },
    parsing: { filters: [], author: [], likes: [], dislikes: [] },
    publish: {
      dryRun: true,
      sources: [{ key: 'best', where: 'true' }],
      template: [publishTemplate()]
    },
    templates: {
      publish: { postCaption: '{{text}}', unknownAuthor: 'unknown', maxTextLength: 700 },
      stats: { summary: 'Stats', topPost: 'Top' }
    }
  };
}
