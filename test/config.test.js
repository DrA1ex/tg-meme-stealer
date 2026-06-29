import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, deepMerge } from '../src/config/index.js';

test('deepMerge preserves defaults and overrides nested values', () => {
  const result = deepMerge(
    {
      telegram: { apiId: 1, apiHash: 'default' },
      publish: { monthTopLimit: 10, dryRun: false }
    },
    {
      telegram: { apiHash: 'custom' },
      publish: { dryRun: true }
    }
  );

  assert.deepEqual(result, {
    telegram: { apiId: 1, apiHash: 'custom' },
    publish: { monthTopLimit: 10, dryRun: true }
  });
});

test('applyEnv maps secrets and telegram ids from environment', () => {
  const result = applyEnv(
    {
      telegram: { sessionFile: 'sessions/user.session' },
      sync: { refreshRecentDays: 7 }
    },
    {
      TELEGRAM_API_ID: '123',
      TELEGRAM_API_HASH: 'hash',
      TELEGRAM_SOURCE_CHAT_ID: '-1001',
      TELEGRAM_TARGET_USER_ID: '42',
      TELEGRAM_ADMIN_ID: '99',
      TELEGRAM_PUBLISH_CHANNEL_ID: '-1002',
      TELEGRAM_BOT_TOKEN: 'token'
    }
  );

  assert.deepEqual(result.telegram, {
    sessionFile: 'sessions/user.session',
    apiId: 123,
    apiHash: 'hash',
    sourceChatId: -1001,
    targetUserId: 42,
    adminId: 99,
    publishChannelId: -1002,
    botToken: 'token'
  });
});
