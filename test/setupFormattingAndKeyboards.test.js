import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSetupMeta,
  findDuplicates,
  findScheduleConflicts,
  formatSchedule,
  formatTemplateLines,
  isPreviewStale,
  setupHtmlScreen,
  setupScreen
} from '../src/telegram/setup/formattingBase.js';
import {
  formatSetupDoctor,
  formatSetupStatus,
  formatLastChange,
  formatNoLastChange
} from '../src/telegram/setup/messages.js';
import {
  mergeReplyOptions,
  technicalRawKeyboard,
  technicalTraceKeyboard
} from '../src/telegram/setup/keyboards.js';

test('setup screen formatters keep sections readable and support HTML screens', () => {
  assert.equal(setupScreen({ icon: 'I', title: 'Title', sections: [['H', ['a', 1, null, undefined, 'b']]] }), 'I Title\n\nH\na\n1\nb');
  assert.equal(setupHtmlScreen({ icon: 'H', title: 'HTML', sections: [['JSON', ['<pre><code>{}</code></pre>']]] }), 'H HTML\n\nJSON\n<pre><code>{}</code></pre>');
});

test('setup status reports stale preview, validation state, schedule lines and conflicts', () => {
  const now = Date.now();
  const meta = { ...createSetupMeta(), changedAt: now, changedArea: 'parser', previewedAt: now - 1000, testedAt: now - 2000 };
  const draft = {
    parsing: { filters: [{ transform: 'hasContent' }], author: [], likes: [], dislikes: [] },
    publish: {
      dryRun: true,
      sources: [{ key: 'best', where: 'likes > 0' }],
      template: [
        template({ key: 'daily_a', schedule: { type: 'daily', time: '11:00' } }),
        template({ key: 'daily_b', schedule: { type: 'daily', time: '11:00' }, windowHours: 12, enabled: false })
      ]
    },
    templates: {}
  };

  const text = formatSetupStatus(draft, { schedule: { timezone: 'Europe/Tallinn' } }, meta);

  assert.equal(isPreviewStale(meta), true);
  assert.match(text, /Setup status/);
  assert.match(text, /Preview is stale after draft changes/);
  assert.match(text, /1 enabled, 1 disabled/);
  assert.match(text, /timezone=Europe\/Tallinn/);
  assert.deepEqual(findDuplicates(['a', 'b', 'a']), ['a']);
  assert.deepEqual(findScheduleConflicts(draft.publish.template), []);
  assert.equal(formatSchedule({ type: 'weekly', weekday: 4, time: '13:00' }), 'weekly day 4 13:00');
  assert.deepEqual(formatTemplateLines(draft.publish.template, { includeDisabled: true }), [
    '- daily_a: enabled, source=best, daily 11:00, window=24h',
    '- daily_b: disabled, source=best, daily 11:00, window=12h'
  ]);
});

test('setup doctor surfaces validation errors, empty selections and schedule conflicts', () => {
  const draft = {
    parsing: {},
    publish: {
      sources: [{ key: 'best', where: 'likes > 0' }],
      template: [
        template({ key: 'dup', source: 'missing', schedule: { type: 'daily', time: '10:00' } }),
        template({ key: 'dup', source: 'best', schedule: { type: 'daily', time: '10:00' } })
      ]
    },
    templates: {}
  };

  const text = formatSetupDoctor({ draft, baseConfig: validBaseConfig(), preview: { scanned: 20, posts: [] } });

  assert.match(text, /Template dup uses unknown source missing/);
  assert.match(text, /Duplicate publish template key: dup/);
  assert.match(text, /Schedule conflict: daily:10:00 is used by dup, dup/);
  assert.match(text, /Content filters matched nothing/);
});

test('last-change screens and navigation keyboards point to the right setup area', () => {
  assert.match(formatNoLastChange(), /No content or publishing changes/);
  assert.match(formatLastChange({ area: 'publishing', title: 'Updated', detailLines: ['- templates: 1 → 2'] }), /templates: 1 → 2/);

  const trace = technicalTraceKeyboard({ mode: 'matched', index: 1, total: 3 }).reply_markup.inline_keyboard;
  assert.deepEqual(trace[0].map((item) => item.callback_data), ['setup:technical_trace:matched:0', 'setup:technical_trace:matched:2']);

  const raw = technicalRawKeyboard({ mode: 'buttons', index: 0, total: 2 }).reply_markup.inline_keyboard;
  assert.deepEqual(raw[0].map((item) => item.callback_data), ['setup:technical_raw:buttons:1']);

  const noNavRaw = technicalRawKeyboard({ mode: 'buttons', index: 0, total: 1 }).reply_markup.inline_keyboard;
  assert.notEqual(noNavRaw[0][0].text, 'Next');

  assert.deepEqual(mergeReplyOptions({ parse_mode: 'HTML', disable_web_page_preview: true }, technicalRawKeyboard()).reply_markup.inline_keyboard.at(-1)[0].callback_data, 'setup:status');
});

function template(overrides = {}) {
  return {
    source: 'best',
    key: 'daily_best',
    enabled: true,
    schedule: { type: 'daily', time: '11:00' },
    windowHours: 24,
    posts: { min: 1, target: 3, max: 5 },
    reactions: { strategy: 'likes', min: 0, includeAbove: 999999 },
    template: 'Best {{count}}',
    ...overrides
  };
}

function validBaseConfig() {
  return {
    telegram: {
      apiId: 1,
      apiHash: 'hash',
      sessionFile: 'session',
      sourceChatId: -100,
      adminId: 1,
      publishChannelId: -200,
      botToken: 'token'
    },
    database: { path: 'posts.sqlite' },
    parsing: { filters: [], author: [], likes: [], dislikes: [] },
    publish: { dryRun: true, sources: [{ key: 'best', where: 'likes > 0' }], template: [] },
    templates: { publish: { postCaption: '{{text}}' }, stats: { summary: 'Stats', topPost: 'Top' } }
  };
}
