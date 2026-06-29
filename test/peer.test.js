import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTelegramPeerId } from '../src/telegram/peer.js';

test('normalizeTelegramPeerId converts numeric strings and keeps usernames', () => {
  assert.equal(normalizeTelegramPeerId('-1001341205233'), -1001341205233);
  assert.equal(normalizeTelegramPeerId(' 12345 '), 12345);
  assert.equal(normalizeTelegramPeerId('channel_username'), 'channel_username');
});
