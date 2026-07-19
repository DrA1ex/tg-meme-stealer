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

test('manual schedule source selection advances instead of toggling source off', async () => {
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
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:manual_source:best/);

  await assistant.manualScheduleSet(ctx, { source: 'best' });

  assert.equal(assistant.setupScheduleWizards.get(1).source, 'best');
  assert.match(replies.at(-1)[0], /Cadence: <choose cadence>/);
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:manual_cadence:/);
  assert.doesNotMatch(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:manual_source:/);
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

test('setup preview uses matched sample posts even when they are older than one week', async () => {
  const replies = [];
  const edits = [];
  const sent = [];
  const captured = [];
  const message = { id: 77, media: { type: 'photo', marker: 'fresh-preview-location' } };
  const post = {
    chatId: -1001,
    messageId: 77,
    messageDate: '2020-01-01T00:00:00.000Z',
    text: 'Preview post',
    author: 'Alice',
    likes: 10,
    dislikes: 1,
    data: { media: [{ messageId: 77, mediaKind: 'photo' }] }
  };
  const assistant = new SetupAssistant({
    scanner: {
      previewRecent: async (_limit, _draft, options) => {
        assert.deepEqual(options, { includeMessages: true });
        return { scanned: 1, posts: [post], messages: [message] };
      }
    },
    mediaDownloader: {
      downloadPostMedia: async (actualPost, mediaContext) => {
        captured.push({ actualPost, mediaContext });
        return [];
      },
      cleanupFiles: async () => {}
    },
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  assistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });
  const ctx = {
    from: { id: 1 },
    chat: { id: 200 },
    message: { text: '/preview 1 10' },
    telegram: {
      sendMessage: async (...args) => { sent.push(args); return { message_id: 500 }; },
      editMessageText: async (...args) => edits.push(args),
      deleteMessage: async () => {}
    },
    reply: async (...args) => {
      replies.push(args);
      return { message_id: 100 + replies.length, chat: { id: 200 } };
    }
  };

  await assistant.sendPreview(ctx, { postCount: 1, messageCount: 10 });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].actualPost, post);
  assert.equal(captured[0].mediaContext.source, 'setup-preview');
  assert.equal(captured[0].mediaContext.sourceMessagesById.get(77), message);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Preview post/);
});


test('setup save ignores repeated clicks and stale callbacks', async () => {
  const replies = [];
  const callbackAnswers = [];
  const saveGate = deferred();
  let saveCalls = 0;
  const baseConfig = {
    telegram: {
      apiId: 123,
      apiHash: 'hash',
      sessionFile: 'sessions/user.session',
      sourceChatId: -1001,
      adminId: 99,
      publishChannelId: -1002,
      botToken: 'token'
    },
    database: { path: 'data/posts.sqlite' },
    parsing: { filters: [], author: [], likes: [], dislikes: [] },
    publish: {
      dryRun: true,
      sources: [{ key: 'best', where: 'true' }],
      template: [{
        source: 'best',
        key: 'daily_best',
        enabled: true,
        schedule: { type: 'daily', time: '10:00' },
        windowHours: 24,
        posts: { min: 1, target: 5, max: 5 },
        reactions: { strategy: 'likes', min: 0, includeAbove: 999999 },
        template: 'Daily {{count}}'
      }]
    },
    templates: {
      publish: { postCaption: '{{text}}', unknownAuthor: 'unknown', maxTextLength: 700 },
      stats: { summary: 'Stats', topPost: 'Top' }
    }
  };
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: baseConfig,
    configLoader: () => baseConfig,
    saveDraft: async () => {
      saveCalls += 1;
      await saveGate.promise;
      return { configPath: '/tmp/config.json', backupPath: null };
    }
  });
  assistant.sessions.set(1, structuredClone({ parsing: baseConfig.parsing, publish: baseConfig.publish, templates: baseConfig.templates }));
  assistant.setupMessages.set(1, { chatId: 200, messageId: 300 });

  const makeCtx = () => ({
    from: { id: 1 },
    chat: { id: 200 },
    callbackQuery: { message: { message_id: 300, chat: { id: 200 } } },
    match: ['setup:save', 'save'],
    answerCbQuery: async (text) => callbackAnswers.push(text || ''),
    telegram: { editMessageReplyMarkup: async () => {} },
    reply: async (...args) => {
      replies.push(args);
      return { message_id: replies.length, chat: { id: 200 } };
    }
  });

  const first = assistant.setupAction(makeCtx());
  await waitUntil(() => saveCalls === 1);
  const second = assistant.setupAction(makeCtx());

  assert.equal(saveCalls, 1);
  assert.ok(assistant.setupSaves.has(1));

  saveGate.resolve();
  await Promise.all([first, second]);

  assert.equal(saveCalls, 1);
  assert.equal(assistant.sessions.has(1), false);
  assert.equal(assistant.setupSaves.has(1), false);
  assert.ok(callbackAnswers.includes('Setup config is already being saved.'));

  await assistant.setupAction(makeCtx());

  assert.equal(saveCalls, 1);
  assert.ok(callbackAnswers.includes('Setup is already saved or no longer active.'));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('setup save failure unlocks the draft and keeps the session editable', async () => {
  const replies = [];
  const baseConfig = {
    telegram: {
      apiId: 123,
      apiHash: 'hash',
      sessionFile: 'sessions/user.session',
      sourceChatId: -1001,
      adminId: 99,
      publishChannelId: -1002,
      botToken: 'token'
    },
    database: { path: 'data/posts.sqlite' },
    parsing: { filters: [], author: [], likes: [], dislikes: [] },
    publish: {
      dryRun: true,
      sources: [{ key: 'best', where: 'true' }],
      template: [{
        source: 'best',
        key: 'daily_best',
        enabled: true,
        schedule: { type: 'daily', time: '10:00' },
        windowHours: 24,
        posts: { min: 1, target: 5, max: 5 },
        reactions: { strategy: 'likes', min: 0, includeAbove: 999999 },
        template: 'Daily {{count}}'
      }]
    },
    templates: {
      publish: { postCaption: '{{text}}', unknownAuthor: 'unknown', maxTextLength: 700 },
      stats: { summary: 'Stats', topPost: 'Top' }
    }
  };
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: baseConfig,
    configLoader: () => baseConfig,
    saveDraft: async () => { throw new Error('disk full'); }
  });
  assistant.sessions.set(1, structuredClone({ parsing: baseConfig.parsing, publish: baseConfig.publish, templates: baseConfig.templates }));
  assistant.setupMessages.set(1, { chatId: 200, messageId: 300 });

  await assistant.setupAction({
    from: { id: 1 },
    chat: { id: 200 },
    callbackQuery: { message: { message_id: 300, chat: { id: 200 } } },
    match: ['setup:save', 'save'],
    answerCbQuery: async () => {},
    telegram: { editMessageReplyMarkup: async () => {} },
    reply: async (...args) => {
      replies.push(args);
      return { message_id: replies.length, chat: { id: 200 } };
    }
  });

  assert.equal(assistant.sessions.has(1), true);
  assert.equal(assistant.setupSaves.has(1), false);
  assert.match(replies.at(-1)[0], /Setup error: disk full/);
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:save/);
});
