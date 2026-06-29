import test from 'node:test';
import assert from 'node:assert/strict';
import { getFloodWaitSeconds } from '../src/telegram/retry.js';

test('getFloodWaitSeconds reads mtcute RpcError seconds', () => {
  assert.equal(getFloodWaitSeconds({ code: 420, text: 'FLOOD_WAIT_%d', seconds: 20 }), 20);
});

test('getFloodWaitSeconds reads numeric suffix from message', () => {
  assert.equal(getFloodWaitSeconds({ message: 'FLOOD_WAIT_42' }), 42);
});
