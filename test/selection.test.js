import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionSpecs,
  getScheduledPublishEntries,
  loadSelections,
  normalizeSelectionKeys
} from '../src/core/selection.js';

test('buildSelectionSpecs builds enabled best and controversial selections', () => {
  const specs = buildSelectionSpecs(config(), new Date('2026-06-29T00:00:00.000Z'));

  assert.deepEqual(specs.map((spec) => spec.key), [
    'best.month',
    'best.week',
    'best.day',
    'controversial.week'
  ]);
  assert.equal(specs[0].limit, 10);
  assert.equal(specs[2].sinceIso, '2026-06-28T00:00:00.000Z');
  assert.equal(specs[3].threshold, 0.3);
});

test('buildSelectionSpecs filters by publish keys and supports aliases', () => {
  const specs = buildSelectionSpecs(config(), new Date('2026-06-29T00:00:00.000Z'), ['week', 'controversial.week']);

  assert.deepEqual(specs.map((spec) => spec.key), ['best.week', 'controversial.week']);
});

test('normalizeSelectionKeys expands type aliases and rejects unknown keys', () => {
  assert.deepEqual(normalizeSelectionKeys('day'), ['best.day']);
  assert.deepEqual(normalizeSelectionKeys('fresh'), ['best.day']);
  assert.deepEqual(normalizeSelectionKeys('controversial'), [
    'controversial.month',
    'controversial.week',
    'controversial.day'
  ]);
  assert.throws(() => normalizeSelectionKeys('year'), /Expected month, week, day, best\.\*, or controversial\.\*/);
});

test('getScheduledPublishEntries reads enabled selection times', () => {
  assert.deepEqual(getScheduledPublishEntries(config()), [
    { key: 'best.month', type: 'best', period: 'month', time: '10:20' },
    { key: 'best.week', type: 'best', period: 'week', time: '10:10' },
    { key: 'best.day', type: 'best', period: 'day', time: '10:00' },
    { key: 'controversial.week', type: 'controversial', period: 'week', time: '11:10' }
  ]);
});

test('loadSelections renders selection templates with count', async () => {
  const repository = {
    getTopPosts: async () => [{ messageId: 1 }],
    getControversialPosts: async () => [{ messageId: 2 }, { messageId: 3 }]
  };

  const selections = await loadSelections(repository, config(), new Date('2026-06-29T00:00:00.000Z'), [
    'best.week',
    'controversial.week'
  ]);

  assert.deepEqual(selections.map((selection) => selection.title), ['Best week (1)', 'Controversial week (2)']);
});

function config() {
  return {
    telegram: { sourceChatId: -1001 },
    publish: {
      selections: {
        best: {
          month: { enabled: true, time: '10:20', limit: 10, template: 'Best month ({{count}})' },
          week: { enabled: true, time: '10:10', limit: 7, template: 'Best week ({{count}})' },
          day: { enabled: true, time: '10:00', limit: 5, windowHours: 24, template: 'Best day ({{count}})' }
        },
        controversial: {
          month: { enabled: false, time: '11:20', limit: 10, threshold: 0.3, template: 'Controversial month ({{count}})' },
          week: { enabled: true, time: '11:10', limit: 7, threshold: 0.3, template: 'Controversial week ({{count}})' },
          day: { enabled: false, time: '11:00', limit: 5, windowHours: 24, threshold: 0.3, template: 'Controversial day ({{count}})' }
        }
      }
    }
  };
}
