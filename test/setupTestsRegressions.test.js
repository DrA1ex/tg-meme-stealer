import assert from 'node:assert/strict';
import test from 'node:test';
import { SetupAssistant } from '../src/telegram/setupAssistant.js';

test('manual schedule stale create callback does not create a default schedule before confirmation', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: { parsing: {}, publish: { sources: [{ key: 'best', where: 'likes > 0' }], template: [] }, templates: {} },
    configLoader: () => ({ parsing: {}, publish: { sources: [{ key: 'best', where: 'likes > 0' }], template: [] }, templates: {} })
  });
  const ctx = plainCtx({ replies });
  assistant.sessions.set(1, { parsing: {}, publish: { sources: [{ key: 'best', where: 'likes > 0' }], template: [] }, templates: {} });

  await assistant.startManualSchedule(ctx);
  assert.equal(assistant.setupScheduleWizards.get(1).cadence, '');

  await assistant.createManualSchedule(ctx);

  assert.deepEqual(assistant.sessions.get(1).publish.template, []);
  assert.equal(assistant.setupLastChange.has(1), false);
  assert.doesNotMatch(replies.at(-1)[0], /Custom schedule created/);
  assert.match(replies.at(-1)[0], /Add custom schedule/);
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:manual_cadence:/);
});

test('single-message parsed preview reports Telegram lookup miss and failure details', async () => {
  const missReplies = [];
  let missLookupId = 0;
  const missAssistant = new SetupAssistant({
    scanner: { getMessageById: async (id) => { missLookupId = id; return null; } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const missCtx = plainCtx({ replies: missReplies });
  missAssistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });

  await missAssistant.technicalSendPreviewMessage(missCtx, 404, 3);

  assert.equal(missLookupId, 404);
  assert.match(missReplies.at(-1)[0], /Loaded setup context: not found/);
  assert.match(missReplies.at(-1)[0], /Telegram source chat: requested, not found/);
  assert.match(missReplies.at(-1)[0], /Telegram returned no message for this id/);
  assert.match(JSON.stringify(missReplies.at(-1)[1].reply_markup.inline_keyboard), /setup:technical_preview:3/);

  const failReplies = [];
  const failAssistant = new SetupAssistant({
    scanner: { getMessageById: async () => { throw new Error('MESSAGE_ID_INVALID'); } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const failCtx = plainCtx({ replies: failReplies });
  failAssistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });

  await failAssistant.technicalSendPreviewMessage(failCtx, 405, 4);

  assert.match(failReplies.at(-1)[0], /Telegram source chat: lookup failed/);
  assert.match(failReplies.at(-1)[0], /MESSAGE_ID_INVALID/);
  assert.match(JSON.stringify(failReplies.at(-1)[1].reply_markup.inline_keyboard), /setup:technical_preview:4/);
});

test('message id prompt keeps retry state and browser page after invalid input', async () => {
  const replies = [];
  let scannerCalls = 0;
  const assistant = new SetupAssistant({
    scanner: { getMessageById: async () => { scannerCalls += 1; return null; } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies });
  assistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });
  assistant.setupSampleCache.set(1, {
    messages: Array.from({ length: 13 }, (_, index) => ({ id: index + 1, message: `cached ${index + 1}` })),
    exhausted: true,
    loadedAt: Date.now(),
    pages: 3
  });
  assistant.setupTextPrompts.set(1, { kind: 'message_browser_id', page: 2 });

  await assistant.handleSetupText({ ...ctx, message: { text: 'abc' } });

  assert.equal(scannerCalls, 0);
  assert.deepEqual(assistant.setupTextPrompts.get(1), { kind: 'message_browser_id', page: 2 });
  assert.match(replies.at(-1)[0], /Message id must be a positive number/);
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:technical_preview_by_id:2/);
});

function plainCtx({ replies = [], edits = [] } = {}) {
  return {
    from: { id: 1 },
    chat: { id: 200 },
    message: { text: '' },
    telegram: {
      editMessageText: async (...args) => edits.push(args),
      editMessageReplyMarkup: async (...args) => edits.push(['markup', ...args])
    },
    reply: async (...args) => {
      replies.push(args);
      return { message_id: replies.length, chat: { id: 200 } };
    }
  };
}
