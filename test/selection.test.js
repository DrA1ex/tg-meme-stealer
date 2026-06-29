import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectionSpecs } from '../src/core/selection.js';

test('buildSelectionSpecs uses configured limits and windows', () => {
  const specs = buildSelectionSpecs(
    {
      telegram: { sourceChatId: -1001 },
      publish: {
        monthTopLimit: 10,
        weekTopLimit: 7,
        freshTopLimit: 5,
        freshWindowHours: 24
      },
      templates: {
        publish: {
          selectionTitles: {
            month: 'Month template',
            week: 'Week template',
            fresh: 'Fresh template'
          }
        }
      }
    },
    new Date('2026-06-29T00:00:00.000Z')
  );

  assert.equal(specs[0].limit, 10);
  assert.equal(specs[0].title, 'Month template');
  assert.equal(specs[1].limit, 7);
  assert.equal(specs[2].limit, 5);
  assert.equal(specs[2].sinceIso, '2026-06-28T00:00:00.000Z');
});
