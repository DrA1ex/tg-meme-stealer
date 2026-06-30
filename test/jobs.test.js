import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJobs } from '../src/core/jobs.js';

test('formatJobs renders active and finished jobs with last errors', () => {
  const text = formatJobs({
    active: [{
      id: 2,
      status: 'running',
      selectionKey: 'best.week',
      sentCount: 1,
      expectedCount: 2,
      updatedAt: '2026-06-29T12:00:00.000Z'
    }],
    finished: [{
      id: 1,
      status: 'failed',
      selectionKey: 'best.day',
      sentCount: 0,
      expectedCount: 5,
      updatedAt: '2026-06-29T11:00:00.000Z',
      lastError: 'network failed'
    }]
  });

  assert.match(text, /Publication jobs/);
  assert.match(text, /Active/);
  assert.match(text, /running/);
  assert.match(text, /1\/2/);
  assert.match(text, /Recent finished/);
  assert.match(text, /network failed/);
});

test('formatJobs renders empty sections', () => {
  const text = formatJobs({ active: [], finished: [] });

  assert.match(text, /Active\nNo jobs/);
  assert.match(text, /Recent finished\nNo jobs/);
});
