import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionSpecs,
  getScheduledPublishEntries,
  loadSelections,
  normalizeSelectionKeys,
  selectPosts
} from '../src/core/selection.js';

test('buildSelectionSpecs builds rolling windows from configured templates', () => {
  const specs = buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'));

  assert.deepEqual(specs.map((spec) => spec.key), [
    'best.daily_morning',
    'best.daily_evening',
    'controversial.weekly_hot'
  ]);
  assert.equal(specs[0].sinceIso, '2026-06-28T10:00:00.000Z');
  assert.equal(specs[0].untilIso, '2026-06-29T10:00:00.000Z');
  assert.equal(specs[0].limit, 20);
  assert.deepEqual(specs[0].posts, { min: 5, target: 10, max: 20 });
  assert.deepEqual(specs[2].reactions, { strategy: 'sum', min: 10, includeAbove: 30 });
});

test('buildSelectionSpecs filters by template key, source key, wildcard, and disabled force option', () => {
  assert.deepEqual(
    buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'), ['daily_morning']).map((spec) => spec.key),
    ['best.daily_morning']
  );
  assert.deepEqual(
    buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'), ['best.daily_evening']).map((spec) => spec.key),
    ['best.daily_evening']
  );
  assert.deepEqual(
    buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'), ['controversial.*']).map((spec) => spec.key),
    ['controversial.weekly_hot']
  );
  assert.deepEqual(
    buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'), ['monthly_hidden']).map((spec) => spec.key),
    []
  );
  assert.deepEqual(
    buildSelectionSpecs(config(), new Date('2026-06-29T10:00:00.000Z'), ['monthly_hidden'], { includeDisabled: true }).map((spec) => spec.key),
    ['best.monthly_hidden']
  );
});

test('buildSelectionSpecs supports separate monthly rolling windows', () => {
  const specs = buildSelectionSpecs({
    telegram: { sourceChatId: -1001 },
    publish: {
      template: [
        template({ source: 'best', key: 'monthly_start', schedule: { type: 'monthly', dayOfMonth: 1, time: '10:00' }, windowHours: 720 }),
        template({ source: 'best', key: 'monthly_mid', schedule: { type: 'monthly', dayOfMonth: 15, time: '10:00' }, windowHours: 720 })
      ]
    }
  }, new Date('2026-06-15T10:00:00.000Z'));

  assert.deepEqual(specs.map((spec) => spec.key), ['best.monthly_start', 'best.monthly_mid']);
  assert.deepEqual(specs.map((spec) => spec.sinceIso), ['2026-05-16T10:00:00.000Z', '2026-05-16T10:00:00.000Z']);
  assert.deepEqual(specs.map((spec) => spec.windowHours), [720, 720]);
});

test('normalizeSelectionKeys expands configured aliases and rejects unknown keys', () => {
  assert.deepEqual(normalizeSelectionKeys('daily_morning', config()), ['best.daily_morning']);
  assert.deepEqual(normalizeSelectionKeys('best.daily_morning', config()), ['best.daily_morning']);
  assert.deepEqual(normalizeSelectionKeys('best.*', config()), [
    'best.daily_morning',
    'best.daily_evening',
    'best.monthly_hidden'
  ]);
  assert.deepEqual(normalizeSelectionKeys('controversial', config()), ['controversial.weekly_hot']);
  assert.throws(() => normalizeSelectionKeys('year', config()), /Expected a template key, source\.key, best\.\*, or controversial\.\*/);
});

test('getScheduledPublishEntries reads enabled schedule objects', () => {
  assert.deepEqual(getScheduledPublishEntries(config()), [
    {
      key: 'best.daily_morning',
      type: 'best',
      source: 'best',
      templateKey: 'daily_morning',
      period: 'daily_morning',
      schedule: { type: 'daily', time: '10:00' }
    },
    {
      key: 'best.daily_evening',
      type: 'best',
      source: 'best',
      templateKey: 'daily_evening',
      period: 'daily_evening',
      schedule: { type: 'daily', time: '18:00' }
    },
    {
      key: 'controversial.weekly_hot',
      type: 'controversial',
      source: 'controversial',
      templateKey: 'weekly_hot',
      period: 'weekly_hot',
      schedule: { type: 'weekly', weekday: 1, time: '11:10' }
    }
  ]);
});

test('loadSelections renders templates with count and windowHours', async () => {
  const repository = {
    getTopPosts: async () => [post(1, 20), post(2, 15)],
    getControversialPosts: async () => [post(3, 20)]
  };

  const selections = await loadSelections(repository, config(), new Date('2026-06-29T10:00:00.000Z'), [
    'daily_morning',
    'weekly_hot'
  ]);

  assert.deepEqual(selections.map((selection) => selection.title), [
    'Best morning 24h (2)',
    'Controversial 168h (1)'
  ]);
});

test('selectPosts filters by reaction min, backfills to minimum, expands includeAbove, and caps at max', () => {
  const candidates = [
    post(1, 100),
    post(2, 50),
    post(3, 20),
    post(4, 5),
    post(5, 1)
  ];

  assert.deepEqual(selectPosts(candidates, spec({ min: 3, target: 3, max: 5 }, { min: 10, includeAbove: 80 })).map((item) => item.messageId), [1, 2, 3]);
  assert.deepEqual(selectPosts(candidates, spec({ min: 4, target: 2, max: 5 }, { min: 10, includeAbove: 999 })).map((item) => item.messageId), [1, 2, 3, 4]);
  assert.deepEqual(selectPosts(candidates, spec({ min: 1, target: 2, max: 4 }, { min: 10, includeAbove: 15 })).map((item) => item.messageId), [1, 2, 3]);
  assert.deepEqual(selectPosts(candidates, spec({ min: 1, target: 2, max: 2 }, { min: 0, includeAbove: 1 })).map((item) => item.messageId), [1, 2]);
});

function config() {
  return {
    telegram: { sourceChatId: -1001 },
    publish: {
      template: [
        template({ source: 'best', key: 'daily_morning', schedule: { type: 'daily', time: '10:00' }, windowHours: 24, template: 'Best morning {{windowHours}}h ({{count}})' }),
        template({ source: 'best', key: 'daily_evening', schedule: { type: 'daily', time: '18:00' }, windowHours: 24, template: 'Best evening {{windowHours}}h ({{count}})' }),
        template({ source: 'best', key: 'monthly_hidden', enabled: false, schedule: { type: 'monthly', dayOfMonth: 15, time: '10:00' }, windowHours: 720 }),
        template({ source: 'controversial', key: 'weekly_hot', schedule: { type: 'weekly', weekday: 1, time: '11:10' }, windowHours: 168, reactions: { strategy: 'sum', min: 10, includeAbove: 30 }, template: 'Controversial {{windowHours}}h ({{count}})' })
      ]
    }
  };
}

function template(overrides) {
  return {
    source: 'best',
    key: 'daily',
    enabled: true,
    schedule: { type: 'daily', time: '10:00' },
    windowHours: 24,
    posts: { min: 5, target: 10, max: 20 },
    reactions: { strategy: 'likes', min: 10, includeAbove: 30 },
    template: '{{key}} {{count}}',
    ...overrides
  };
}

function spec(posts, reactions) {
  return { posts, reactions: { strategy: 'likes', ...reactions } };
}

function post(messageId, likes, dislikes = 0) {
  return { chatId: -1001, messageId, likes, dislikes };
}
