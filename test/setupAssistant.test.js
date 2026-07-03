import assert from 'node:assert/strict';
import test from 'node:test';
import { SetupAssistant, stringifyForSetup } from '../src/telegram/setupAssistant.js';

test('stringifyForSetup handles BigInt, functions and circular references', () => {
  const value = {
    id: 10n,
    fn: function namedFunction() {}
  };
  value.self = value;

  const parsed = JSON.parse(stringifyForSetup(value));

  assert.equal(parsed.id, '10');
  assert.equal(parsed.fn, '[Function namedFunction]');
  assert.equal(parsed.self, '[Circular]');
});

test('SetupAssistant.start opens button-driven setup screen and stores keyboard state', async () => {
  const replies = [];
  const config = {
    parsing: {},
    publish: { dryRun: false },
    templates: {}
  };
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config,
    configLoader: () => config
  });

  await assistant.start({
    from: { id: 1 },
    reply: async (...args) => {
      replies.push(args);
      return { message_id: 100, chat: { id: 200 } };
    }
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0][0], /🧰 Setup mode/);
  assert.match(replies[0][0], /📌 Current draft/);
  assert.match(replies[0][0], /Content: 0 filter\(s\)/);
  assert.equal(replies[0][1].parse_mode, undefined);
  assert.deepEqual(replies[0][1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:status', 'setup:doctor']);
  assert.deepEqual(assistant.setupMessages.get(1), { chatId: 200, messageId: 100 });
});

test('SetupAssistant.start reloads config before creating a new draft', async () => {
  const replies = [];
  const config = {
    parsing: { filters: [{ transform: 'old' }] },
    publish: { dryRun: false },
    templates: {}
  };
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config,
    configLoader: () => ({
      parsing: { filters: [{ transform: 'hasContent' }] },
      publish: { dryRun: true },
      templates: { publish: { unknownAuthor: 'anonymous' } }
    })
  });

  await assistant.start({
    from: { id: 1 },
    reply: async (...args) => replies.push(args)
  });

  assert.deepEqual(config.parsing, { filters: [{ transform: 'hasContent' }] });
  assert.equal(config.publish.dryRun, true);
  assert.deepEqual(assistant.sessions.get(1).parsing, { filters: [{ transform: 'hasContent' }] });
  assert.match(replies[0][0], /Content: 1 filter\(s\)/);
  assert.doesNotMatch(replies[0][0], /old/);
});

test('SetupAssistant.test sends parsed table as HTML code block', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {
      previewRecent: async () => ({
        scanned: 1,
        posts: [{
          messageId: 10,
          author: 'Alice',
          likes: 3,
          dislikes: 1,
          text: 'Text',
          data: { media: [{ mediaKind: 'photo' }] }
        }]
      })
    },
    mediaDownloader: {},
    config: {
      parsing: {},
      publish: { dryRun: false },
      templates: {}
    },
    configLoader: () => ({
      parsing: {},
      publish: { dryRun: false },
      templates: {}
    })
  });
  const ctx = {
    from: { id: 1 },
    message: { text: '/test 1' },
    reply: async (...args) => replies.push(args)
  };

  assistant.sessions.set(1, { parsing: {} });
  await assistant.test(ctx);

  assert.match(replies[0][0], /^<pre><code>/);
  assert.equal(replies[0][1].parse_mode, 'HTML');
  assert.match(replies[0][0], / # \| id \| author /);
});

test('SetupAssistant updates publish sources and templates in setup draft', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: {
      parsing: {},
      publish: { sources: [], template: [] },
      templates: {}
    },
    configLoader: () => ({
      parsing: {},
      publish: { sources: [], template: [] },
      templates: {}
    })
  });
  const ctx = {
    from: { id: 1 },
    reply: async (...args) => replies.push(args)
  };

  assistant.sessions.set(1, { parsing: {}, publish: { sources: [], template: [] }, templates: {} });
  await assistant.setSource({
    ...ctx,
    message: { text: '/setsource {"key":"positive","where":"likes > dislikes"}' }
  });
  await assistant.setPublish({
    ...ctx,
    message: {
      text: '/setpublish {"source":"positive","key":"daily_positive","enabled":false,"schedule":{"type":"daily","time":"12:00"},"windowHours":24,"posts":{"min":1,"target":3,"max":5},"reactions":{"strategy":"likes","min":0,"includeAbove":999999},"template":"Positive {{count}}"}'
    }
  });
  await assistant.setTemplate({
    ...ctx,
    message: { text: '/settemplate publish.template.daily_positive.template Updated {{count}}' }
  });

  assert.deepEqual(assistant.sessions.get(1).publish.sources, [
    { key: 'positive', where: 'likes > dislikes' }
  ]);
  assert.equal(assistant.sessions.get(1).publish.template[0].key, 'daily_positive');
  assert.equal(assistant.sessions.get(1).publish.template[0].template, 'Updated {{count}}');
  assert.equal(assistant.sessions.get(1).publish.selections, undefined);
});

test('SetupAssistant.technicalRaw uses cached diagnostic messages and keeps JSON as HTML code block with Next navigation', async () => {
  const edits = [];
  const assistant = new SetupAssistant({
    scanner: { previewAdaptive: async () => { throw new Error('scanner should not be called when exhausted cache is usable'); } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const ctx = callbackCtx({ edits });
  assistant.sessions.set(1, { parsing: { filters: [{ source: 'message', transform: 'hasContent' }] } });
  assistant.setupSampleCache.set(1, {
    messages: [sampleMessage({ id: 10, text: '<b>raw</b>', buttons: ['👍 1'] }), sampleMessage({ id: 11, text: 'next', buttons: ['👍 2'] })],
    exhausted: true,
    loadedAt: Date.now(),
    pages: 1
  });

  await assistant.technicalRaw(ctx, 'buttons', 0);

  assert.equal(edits.length, 1);
  assert.match(edits[0][3], /<pre><code class="language-json">/);
  assert.match(edits[0][3], /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.equal(edits[0][4].parse_mode, 'HTML');
  assert.deepEqual(edits[0][4].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:technical_raw:buttons:1']);
  assert.equal(assistant.getCurrentView(ctx), 'technical_raw:buttons:0');
});

test('SetupAssistant.technicalTrace clamps requested index to available diagnostic matches', async () => {
  const edits = [];
  const assistant = new SetupAssistant({
    scanner: { previewAdaptive: async () => { throw new Error('scanner should not be called when exhausted cache is usable'); } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const ctx = callbackCtx({ edits });
  assistant.sessions.set(1, { parsing: { filters: [{ source: 'message', transform: 'hasContent' }] } });
  assistant.setupSampleCache.set(1, {
    messages: [sampleMessage({ id: 20, text: 'first' }), sampleMessage({ id: 21, text: 'second' })],
    exhausted: true,
    loadedAt: Date.now(),
    pages: 1
  });

  await assistant.technicalTrace(ctx, 'matched', 99);

  assert.match(edits[0][3], /Item: 2\/2/);
  assert.deepEqual(edits[0][4].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:technical_trace:matched:0']);
  assert.equal(assistant.getCurrentView(ctx), 'technical_trace:matched:1');
});

test('SetupAssistant.collectSetupSample loads more from cache instead of throwing away existing sample context', async () => {
  const calls = [];
  const replies = [];
  const edits = [];
  const assistant = new SetupAssistant({
    scanner: {
      previewAdaptive: async (args) => {
        calls.push(args);
        await args.onProgress({ scanned: 3, matched: 2, minMatched: Number.POSITIVE_INFINITY, maxLimit: 5 });
        return {
          scanned: 4,
          posts: [{ messageId: 1 }, { messageId: 2 }],
          messages: [...args.seedMessages, sampleMessage({ id: 3 }), sampleMessage({ id: 4 })],
          nextOffset: 4,
          exhausted: false,
          pages: 2
        };
      }
    },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies, edits });
  assistant.sessions.set(1, { parsing: { filters: [{ source: 'message', transform: 'hasContent' }] } });
  assistant.setupSampleCache.set(1, {
    messages: [sampleMessage({ id: 1 }), sampleMessage({ id: 2 })],
    nextOffset: 2,
    exhausted: false,
    pages: 1,
    loadedAt: Date.now()
  });

  const result = await assistant.collectSetupSample(ctx, {
    purpose: 'load more smoke test',
    initialLimit: 2,
    step: 2,
    maxLimit: 5,
    includeMessages: true,
    forceLoadMore: true
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].initialLimit, 4);
  assert.equal(calls[0].seedOffset, 2);
  assert.equal(calls[0].seedMessages.length, 2);
  assert.equal(result.messages.length, 4);
  assert.equal(assistant.setupSampleCache.get(1).messages.length, 4);
  assert.match(replies[0][0], /Collecting sample/);
  assert.ok(edits.some((edit) => /Done\./.test(edit[3])));
});

test('SetupAssistant.handleSetupText validates custom source prompt and clears it only after success', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: { publish: {}, parsing: {}, templates: {} },
    configLoader: () => ({ publish: {}, parsing: {}, templates: {} })
  });
  const ctx = plainCtx({ replies });
  assistant.sessions.set(1, { publish: { sources: [] }, parsing: {}, templates: {} });
  assistant.setupTextPrompts.set(1, { kind: 'source_custom' });

  await assistant.handleSetupText({ ...ctx, message: { text: 'bad key\nlikes > 0' } });
  assert.equal(assistant.setupTextPrompts.has(1), true);
  assert.match(replies.at(-1)[0], /Source key must start/);

  await assistant.handleSetupText({ ...ctx, message: { text: 'positive\nlikes > dislikes and likes >= 10' } });
  assert.equal(assistant.setupTextPrompts.has(1), false);
  assert.deepEqual(assistant.sessions.get(1).publish.sources, [{ key: 'positive', where: 'likes > dislikes and likes >= 10' }]);
  assert.match(replies.at(-1)[0], /✅ Source added: positive/);
  assert.equal(assistant.setupLastChange.get(1).area, 'publishing');
});

test('SetupAssistant.applySuggestion treats active filter suggestions as removable actions', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: { parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ parsing: {}, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies });
  const filterRule = { source: 'message', transform: 'hasContent' };
  assistant.sessions.set(1, { parsing: { filters: [filterRule], author: [], likes: [], dislikes: [] }, publish: {}, templates: {} });
  assistant.setupSampleCache.set(1, {
    messages: [sampleMessage({ id: 30, text: 'cached message' })],
    exhausted: true,
    loadedAt: Date.now(),
    pages: 1
  });
  assistant.setupSuggestions.set(1, [{
    id: 'f_content',
    title: 'Content filter · has content',
    description: 'messages with content',
    filterRules: [filterRule],
    apply: (draft) => { draft.parsing.filters.push(filterRule); }
  }]);

  await assistant.applySuggestion(ctx, 'f_content');

  assert.deepEqual(assistant.sessions.get(1).parsing.filters, []);
  assert.match(replies.at(-1)[0], /Filter options/);
  assert.match(assistant.setupLastChange.get(1).title, /Removed filter suggestion/);
});

function sampleMessage({ id, text = 'Post', buttons = [], nativeReactions = [], photo = true } = {}) {
  return {
    id,
    date: 1717200000 + Number(id || 0),
    message: text,
    text,
    senderId: 42,
    sender: { id: 42, firstName: 'Source', username: 'source_bot' },
    photo: photo ? { id: Number(id || 1) * 1000 } : undefined,
    nativeReactions,
    replyMarkup: buttons.length
      ? { rows: [{ buttons: buttons.map((text) => ({ text })) }] }
      : undefined
  };
}

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

function callbackCtx({ edits = [], replies = [] } = {}) {
  return {
    ...plainCtx({ replies, edits }),
    callbackQuery: { message: { message_id: 300, chat: { id: 200 } } }
  };
}
