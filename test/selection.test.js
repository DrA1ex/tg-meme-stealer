import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionSpecs,
  getScheduledPublishEntries,
  loadSelections,
  normalizeSelectionKeys
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
  assert.equal(specs[0].firstSendAtIso, '2026-06-30T00:00:00.000Z');
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

test('buildSelectionSpecs uses later global or template firstSendAt', () => {
  const specs = buildSelectionSpecs({
    telegram: { sourceChatId: -1001 },
    publish: {
      firstSendAt: '2026-10-01T00:00:00.000Z',
      template: [
        template({ source: 'best', key: 'early_template', firstSendAt: '2026-01-01T00:00:00.000Z' }),
        template({ source: 'best', key: 'late_template', firstSendAt: '2026-12-01T00:00:00.000Z' }),
        template({ source: 'best', key: 'global_only' })
      ]
    }
  }, new Date('2026-06-15T10:00:00.000Z'));

  assert.deepEqual(specs.map((spec) => [spec.templateKey, spec.firstSendAtIso]), [
    ['early_template', '2026-10-01T00:00:00.000Z'],
    ['late_template', '2026-12-01T00:00:00.000Z'],
    ['global_only', '2026-10-01T00:00:00.000Z']
  ]);
});

test('normalizeSelectionKeys expands configured aliases and rejects unknown keys', () => {
  assert.deepEqual(normalizeSelectionKeys('daily_morning', config()), ['best.daily_morning']);
  assert.deepEqual(normalizeSelectionKeys('best.daily_morning', config()), ['best.daily_morning']);
  assert.deepEqual(normalizeSelectionKeys('positive.*', config()), ['positive.daily_positive']);
  assert.deepEqual(normalizeSelectionKeys('best.*', config()), [
    'best.daily_morning',
    'best.daily_evening',
    'best.monthly_hidden'
  ]);
  assert.deepEqual(normalizeSelectionKeys('controversial', config()), ['controversial.weekly_hot']);
  assert.throws(() => normalizeSelectionKeys('year', config()), /Expected a template key, source\.key, or source\.\*/);
});

test('getScheduledPublishEntries reads enabled schedule objects', () => {
  assert.deepEqual(getScheduledPublishEntries(config()), [
    {
      key: 'best.daily_morning',
      type: 'best',
      source: 'best',
      templateKey: 'daily_morning',
      period: 'daily_morning',
      schedule: { type: 'daily', time: '10:00' },
      firstSendAtIso: '2026-06-30T00:00:00.000Z'
    },
    {
      key: 'best.daily_evening',
      type: 'best',
      source: 'best',
      templateKey: 'daily_evening',
      period: 'daily_evening',
      schedule: { type: 'daily', time: '18:00' },
      firstSendAtIso: null
    },
    {
      key: 'controversial.weekly_hot',
      type: 'controversial',
      source: 'controversial',
      templateKey: 'weekly_hot',
      period: 'weekly_hot',
      schedule: { type: 'weekly', weekday: 1, time: '11:10' },
      firstSendAtIso: null
    }
  ]);
});

test('loadSelections renders templates with count and windowHours', async () => {
  const repository = {
    getSelectionPosts: async (spec) => {
      if (spec.source === 'controversial') return [post(3, 20)];
      return [post(1, 20), post(2, 15)];
    }
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

function config() {
  return {
    telegram: { sourceChatId: -1001 },
    publish: {
      sources: [
        { key: 'positive', where: 'likes > dislikes' }
      ],
      template: [
        template({ source: 'best', key: 'daily_morning', schedule: { type: 'daily', time: '10:00' }, windowHours: 24, firstSendAt: '2026-06-30T00:00:00.000Z', template: 'Best morning {{windowHours}}h ({{count}})' }),
        template({ source: 'best', key: 'daily_evening', schedule: { type: 'daily', time: '18:00' }, windowHours: 24, template: 'Best evening {{windowHours}}h ({{count}})' }),
        template({ source: 'best', key: 'monthly_hidden', enabled: false, schedule: { type: 'monthly', dayOfMonth: 15, time: '10:00' }, windowHours: 720 }),
        template({ source: 'controversial', key: 'weekly_hot', schedule: { type: 'weekly', weekday: 1, time: '11:10' }, windowHours: 168, reactions: { strategy: 'sum', min: 10, includeAbove: 30 }, template: 'Controversial {{windowHours}}h ({{count}})' }),
        template({ source: 'positive', key: 'daily_positive', enabled: false, schedule: { type: 'daily', time: '12:00' }, windowHours: 24, template: 'Positive {{windowHours}}h ({{count}})' })
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

function post(messageId, likes, dislikes = 0) {
  return { chatId: -1001, messageId, likes, dislikes };
}
