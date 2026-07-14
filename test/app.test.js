import assert from 'node:assert/strict';
import test from 'node:test';
import { settleBeforeDeadline } from '../src/runtime/app.js';

test('settleBeforeDeadline reports completed work', async () => {
  assert.equal(await settleBeforeDeadline(Promise.resolve('done'), Date.now() + 100), true);
});

test('settleBeforeDeadline bounds work that never settles', async () => {
  const startedAt = Date.now();
  assert.equal(await settleBeforeDeadline(new Promise(() => {}), startedAt + 5), false);
  assert.ok(Date.now() - startedAt < 100);
});
