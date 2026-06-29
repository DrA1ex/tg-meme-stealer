import assert from 'node:assert/strict';
import test from 'node:test';
import { getBackfillPostAction, getInitialScanDays } from '../src/telegram/scanner.js';

test('getInitialScanDays reads configured days and falls back to 60', () => {
  assert.equal(getInitialScanDays({ sync: { initialScanDays: 45 } }), 45);
  assert.equal(getInitialScanDays({ sync: {} }), 60);
});

test('getBackfillPostAction adds missing old posts and updates only recent existing posts', () => {
  const sinceDate = new Date('2026-05-01T00:00:00.000Z');
  const updateSinceDate = new Date('2026-06-22T00:00:00.000Z');
  const existingIds = new Set([1, 2]);

  assert.equal(getBackfillPostAction({
    post: post(1, '2026-06-25T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'update');
  assert.equal(getBackfillPostAction({
    post: post(2, '2026-06-01T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'skip-existing-old');
  assert.equal(getBackfillPostAction({
    post: post(3, '2026-06-01T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'add');
  assert.equal(getBackfillPostAction({
    post: post(4, '2026-04-30T00:00:00.000Z'),
    sinceDate,
    updateSinceDate,
    existingIds
  }), 'skip-old');
});

function post(messageId, messageDate) {
  return { messageId, messageDate };
}
