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

test('SetupAssistant.start sends draft config as HTML code block', async () => {
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
    reply: async (...args) => replies.push(args)
  });

  assert.match(replies[0][0], /Current draft:/);
  assert.match(replies[1][0], /^<pre><code class="language-json">/);
  assert.equal(replies[1][1].parse_mode, 'HTML');
  assert.doesNotMatch(replies[1][0], /"sync"/);
  assert.match(replies[1][0], /"parsing"/);
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
  assert.match(replies[1][0], /"hasContent"/);
  assert.doesNotMatch(replies[1][0], /"old"/);
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
