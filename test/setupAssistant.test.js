import assert from 'node:assert/strict';
import test from 'node:test';
import { SetupAssistant, stringifyForSetup } from '../src/telegram/setupAssistant.js';
import { normalizeLoadMoreTarget } from '../src/telegram/setupAssistant/helpers.js';

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

test('setup load-more target normalizer keeps single-message browser views', () => {
  assert.equal(normalizeLoadMoreTarget('', 'technical_msg:77:2:raw_reactions'), 'technical_msg:77:2:raw_reactions');
  assert.equal(normalizeLoadMoreTarget('technical_msg:88:1:shape', 'suggest'), 'technical_msg:88:1:shape');
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
  assert.match(replies[0][0], /🧰 Setup home/);
  assert.match(replies[0][0], /📌 Draft summary/);
  assert.match(replies[0][0], /Content: 0 filter\(s\)/);
  assert.equal(replies[0][1].parse_mode, undefined);
  assert.deepEqual(replies[0][1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:parser', 'setup:publish']);
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


test('SetupAssistant routing keeps command aliases, save semantics and callback prompt cleanup', async () => {
  const replies = [];
  const edits = [];
  const assistant = new SetupAssistant({
    scanner: {
      previewAdaptive: async () => ({
        scanned: 1,
        posts: [],
        messages: [sampleMessage({ id: 40, text: 'suggest me' })],
        exhausted: true,
        pages: 1
      })
    },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: { sources: [] }, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: { sources: [] }, templates: {} })
  });
  const ctx = plainCtx({ replies, edits });

  await assistant.setupCommand({ ...ctx, message: { text: '/setup save' } });
  assert.equal(assistant.sessions.has(1), false);
  assert.match(replies.at(-1)[0], /Setup mode is not active/);

  await assistant.setupCommand({ ...ctx, message: { text: '/setup suggestions' } });
  assert.equal(assistant.sessions.has(1), true);
  assert.ok(Array.isArray(assistant.setupSuggestions.get(1)));
  assert.match(replies.at(-1)[0], /Quick setup|Recommended setup/);

  await assistant.setupCommand({ ...ctx, message: { text: '/setup home' } });
  assert.match(replies.at(-1)[0], /Setup home/);
  assert.deepEqual(replies.at(-1)[1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:parser', 'setup:publish']);

  await assistant.setupCommand({ ...ctx, message: { text: '/setup status' } });
  assert.match(replies.at(-1)[0], /Setup status/);
  assert.deepEqual(replies.at(-1)[1].reply_markup.inline_keyboard.at(-1).map((item) => item.callback_data), ['setup:home']);

  await assistant.setupCommand({ ...ctx, message: { text: '/setup check' } });
  assert.match(replies.at(-1)[0], /Check & save/);
  assert.deepEqual(replies.at(-1)[1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:status', 'setup:doctor']);

  await assistant.setupAction({
    ...ctx,
    callbackQuery: { message: { message_id: 501, chat: { id: 200 } } },
    match: ['setup:technical_raw_tools', 'technical_raw_tools'],
    answerCbQuery: async () => {}
  });
  assert.match(replies.at(-1)[0], /Raw \/ advanced tools/);

  assistant.setupTextPrompts.set(1, { kind: 'source_custom' });
  await assistant.setupAction({
    ...ctx,
    callbackQuery: { message: { message_id: 500, chat: { id: 200 } } },
    match: ['setup:source_custom_cancel', 'source_custom_cancel'],
    answerCbQuery: async () => {}
  });
  assert.equal(assistant.setupTextPrompts.has(1), false);
  assert.match(replies.at(-1)[0], /Publish sources/);
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

test('manual reaction and author selections return to content flow and keep pending config accessible', async () => {
  const replies = [];
  const edits = [];
  const assistant = new SetupAssistant({
    scanner: { previewAdaptive: async () => ({ scanned: 2, posts: [], messages: [
      sampleMessage({ id: 50, text: 'By: Alice\nPost', buttons: ['👍 10', '🐳 8', '👎 2', '💩 1'] }),
      sampleMessage({ id: 51, text: 'By: Bob\nPost', buttons: ['🔥 4', '🤡 1'] })
    ], exhausted: true, pages: 1 }) },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies, edits });
  assistant.sessions.set(1, { parsing: { filters: [], author: [], likes: [], dislikes: [] }, publish: {}, templates: {} });

  await assistant.reactionOptions(ctx);
  assert.ok(assistant.setupSuggestions.get(1).some((item) => item.id === 'r_buttons_except_negative'));
  await assistant.applySuggestion(ctx, 'r_buttons_except_negative');

  const reactionReply = replies.at(-1);
  assert.match(reactionReply[0], /Reaction rules updated|Suggestion applied/);
  assert.doesNotMatch(JSON.stringify(reactionReply[1].reply_markup.inline_keyboard), /Apply suggested content setup/);
  assert.ok(reactionReply[1].reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'setup:reactions_pending_config'));
  assert.match(assistant.sessions.get(1).parsing.likes[0].regex, /\(\?!\.\*\(/);

  await assistant.authorOptions(ctx);
  await assistant.applySuggestion(ctx, 'a_label_multilingual');
  const authorReply = replies.at(-1);
  assert.match(authorReply[0], /Author rules updated|Suggestion applied/);
  assert.doesNotMatch(JSON.stringify(authorReply[1].reply_markup.inline_keyboard), /Apply suggested content setup/);
  assert.ok(authorReply[1].reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'setup:author_pending_config'));
});

test('setup exposes diagnostics from home and shows saved versus pending content config explicitly', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: { parsing: { likes: [{ source: 'saved', path: 'old' }] }, publish: {}, templates: {} },
    configLoader: () => ({ parsing: { likes: [{ source: 'saved', path: 'old' }] }, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies });
  assistant.sessions.set(1, { parsing: { likes: [{ source: 'pending', path: 'new' }], dislikes: [] }, publish: {}, templates: {} });

  await assistant.home(ctx);
  const homeButtons = replies.at(-1)[1].reply_markup.inline_keyboard.flat().map((item) => item.callback_data);
  assert.ok(homeButtons.includes('setup:technical'));

  await assistant.parserMenu(ctx);
  const parserButtons = replies.at(-1)[1].reply_markup.inline_keyboard.flat().map((item) => item.callback_data);
  assert.ok(parserButtons.includes('setup:parser_config'));
  assert.ok(parserButtons.includes('setup:saved_parser_config'));
  assert.equal(parserButtons.includes('setup:technical'), false);

  await assistant.showParserConfig(ctx);
  assert.ok(replies.slice(-3).some(([text]) => /Pending content config/.test(text)));
  assert.equal(replies.at(-1)[0].includes('Use Test content'), true);

  await assistant.showSavedParserConfig(ctx);
  assert.ok(replies.slice(-3).some(([text]) => /Saved content config/.test(text)));

  await assistant.showPublishConfig(ctx);
  assert.ok(replies.slice(-3).some(([text]) => /Pending publishing config/.test(text)));
  assert.match(replies.at(-1)[0], /pending publishing draft/i);
});

test('section pending config screens show only the relevant pending parser slice', async () => {
  const replies = [];
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: { parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ parsing: {}, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies });
  assistant.sessions.set(1, {
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      author: [{ source: 'sender', path: 'firstName' }],
      likes: [{ source: 'message', path: 'buttons' }],
      dislikes: [{ source: 'message', path: 'buttons', regex: '👎' }]
    },
    publish: {},
    templates: {}
  });

  await assistant.showPendingSectionConfig(ctx, 'filters');
  assert.ok(replies.slice(-3).some(([text]) => /Pending filters config/.test(text)));
  assert.deepEqual(replies.at(-1)[1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), ['setup:filters_options', 'setup:filter_impact']);

  await assistant.showPendingSectionConfig(ctx, 'reactions');
  assert.ok(replies.slice(-3).some(([text]) => /Pending likes config/.test(text)));
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:reaction_options/);
});

test('message browser can inspect an entered id from cache, switch modes by editing, and keep browser back flow', async () => {
  const replies = [];
  const edits = [];
  let scannerCalls = 0;
  const assistant = new SetupAssistant({
    scanner: { getMessageById: async () => { scannerCalls += 1; return null; } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies, edits });
  assistant.sessions.set(1, { parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} });
  assistant.setupSampleCache.set(1, {
    messages: [sampleMessage({ id: 77, text: 'By: Alice\nCached post', buttons: ['👍 10', '👎 2'] })],
    exhausted: true,
    loadedAt: Date.now(),
    pages: 1
  });

  await assistant.technicalMessageByIdPrompt(ctx);
  assert.equal(assistant.setupTextPrompts.get(1).kind, 'message_browser_id');
  await assistant.handleSetupText({ ...ctx, message: { text: '77' } });

  assert.equal(scannerCalls, 0);
  assert.match(replies.at(-1)[0], /Message overview · #77/);
  assert.match(replies.at(-1)[0], /Loaded setup context: found/);
  assert.match(replies.at(-1)[0], /Telegram source chat: not requested/);
  assert.deepEqual(replies.at(-1)[1].reply_markup.inline_keyboard[0].map((item) => item.callback_data), [
    'setup:technical_msg:77:0:overview',
    'setup:technical_msg:77:0:raw_reactions',
    'setup:technical_msg:77:0:shape'
  ]);
  assert.ok(replies.at(-1)[1].reply_markup.inline_keyboard.flat().some((item) => item.callback_data === 'setup:technical_send_preview:77:0'));

  await assistant.setupAction({
    ...callbackCtx({ replies, edits }),
    match: ['setup:technical_msg:77:0:raw_reactions', 'technical_msg:77:0:raw_reactions'],
    answerCbQuery: async () => {}
  });
  assert.match(edits.at(-1)[3], /Raw reactions · #77/);
  assert.match(JSON.stringify(edits.at(-1)[4].reply_markup.inline_keyboard), /setup:technical_preview:0/);

  await assistant.setupAction({
    ...callbackCtx({ replies, edits }),
    match: ['setup:technical_msg:77:0:shape', 'technical_msg:77:0:shape'],
    answerCbQuery: async () => {}
  });
  assert.match(edits.at(-1)[3], /Message shape · #77/);
});


test('message browser id prompt preserves current browser page and scanner-fetched messages use the same back flow', async () => {
  const replies = [];
  const edits = [];
  let fetchedId = 0;
  const assistant = new SetupAssistant({
    scanner: {
      getMessageById: async (id) => {
        fetchedId = id;
        return sampleMessage({ id, text: 'By: Remote\nFetched post', buttons: ['👍 7'] });
      }
    },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} })
  });
  const ctx = plainCtx({ replies, edits });
  assistant.sessions.set(1, { parsing: { filters: [{ source: 'message', transform: 'hasContent' }] }, publish: {}, templates: {} });
  assistant.setupSampleCache.set(1, {
    messages: [
      sampleMessage({ id: 10 }), sampleMessage({ id: 11 }), sampleMessage({ id: 12 }),
      sampleMessage({ id: 13 }), sampleMessage({ id: 14 }), sampleMessage({ id: 15 }),
      sampleMessage({ id: 16 })
    ],
    exhausted: true,
    loadedAt: Date.now(),
    pages: 1
  });

  await assistant.technicalMessageBrowser(ctx, 1);
  const browserButtons = replies.at(-1)[1].reply_markup.inline_keyboard.flat().map((item) => item.callback_data);
  assert.ok(browserButtons.includes('setup:technical_preview_by_id:1'));

  await assistant.setupAction({
    ...callbackCtx({ replies, edits }),
    match: ['setup:technical_preview_by_id:1', 'technical_preview_by_id:1'],
    answerCbQuery: async () => {}
  });
  assert.deepEqual(assistant.setupTextPrompts.get(1), { kind: 'message_browser_id', page: 1 });

  await assistant.handleSetupText({ ...ctx, message: { text: '#999' } });

  assert.equal(fetchedId, 999);
  assert.match(replies.at(-1)[0], /Message overview · #999/);
  assert.match(replies.at(-1)[0], /Loaded setup context: not found/);
  assert.match(replies.at(-1)[0], /Telegram source chat: loaded by id/);
  assert.match(JSON.stringify(replies.at(-1)[1].reply_markup.inline_keyboard), /setup:technical_preview:1/);
  assert.ok(assistant.setupSampleCache.get(1).messages.some((message) => Number(message.id) === 999));
});

test('message browser id lookup reports Telegram misses and lookup failures explicitly', async () => {
  const missReplies = [];
  let missFetchedId = 0;
  const missAssistant = new SetupAssistant({
    scanner: {
      getMessageById: async (id) => {
        missFetchedId = id;
        return null;
      }
    },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const missCtx = plainCtx({ replies: missReplies });
  missAssistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });
  missAssistant.setupTextPrompts.set(1, { kind: 'message_browser_id', page: 0 });

  await missAssistant.handleSetupText({ ...missCtx, message: { text: '404' } });

  assert.equal(missFetchedId, 404);
  assert.match(missReplies.at(-1)[0], /Loaded setup context: not found/);
  assert.match(missReplies.at(-1)[0], /Telegram source chat: requested, not found/);
  assert.match(missReplies.at(-1)[0], /Telegram returned no message for this id/);

  const failReplies = [];
  const failAssistant = new SetupAssistant({
    scanner: { getMessageById: async () => { throw new Error('CHAT_ID_INVALID'); } },
    mediaDownloader: {},
    config: { telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} },
    configLoader: () => ({ telegram: { sourceChatId: -1001 }, parsing: {}, publish: {}, templates: {} })
  });
  const failCtx = plainCtx({ replies: failReplies });
  failAssistant.sessions.set(1, { parsing: {}, publish: {}, templates: {} });
  failAssistant.setupTextPrompts.set(1, { kind: 'message_browser_id', page: 0 });

  await failAssistant.handleSetupText({ ...failCtx, message: { text: '405' } });

  assert.match(failReplies.at(-1)[0], /Telegram source chat: lookup failed/);
  assert.match(failReplies.at(-1)[0], /CHAT_ID_INVALID/);
});
