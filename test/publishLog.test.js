import test from 'node:test';
import assert from 'node:assert/strict';
import { formatScheduledPublishLog } from '../src/runtime/publishLog.js';

test('formatScheduledPublishLog describes already completed publications without empty fields', () => {
  const fields = formatScheduledPublishLog({
    selections: [{
      key: 'best.month',
      status: 'exists',
      requested: false,
      publicationStatus: 'published'
    }]
  });

  assert.deepEqual(fields, {
    outcome: 'skipped',
    message: '1 already published or scheduled',
    alreadyDone: 'best.month (published)'
  });
});

test('formatScheduledPublishLog describes created and empty selections clearly', () => {
  const fields = formatScheduledPublishLog({
    selections: [
      { key: 'best.day', status: 'scheduled', requested: true },
      { key: 'controversial.day', status: 'empty', requested: false }
    ]
  });

  assert.deepEqual(fields, {
    outcome: 'created',
    message: '1 publication request created; 1 skipped because there are no posts',
    created: 'best.day',
    noPosts: 'controversial.day'
  });
});

test('formatScheduledPublishLog describes skipped schedule jobs clearly', () => {
  const fields = formatScheduledPublishLog({
    skipped: true,
    reason: 'duplicate_job'
  });

  assert.deepEqual(fields, {
    outcome: 'skipped',
    message: 'The same scheduled publication is already being planned.',
    reason: 'duplicate_job'
  });
});
