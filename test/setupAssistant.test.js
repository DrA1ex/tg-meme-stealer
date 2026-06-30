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
  const assistant = new SetupAssistant({
    scanner: {},
    mediaDownloader: {},
    config: {
      sync: { source: { mode: 'all' } },
      parsing: {},
      publish: { dryRun: false },
      templates: {}
    }
  });

  await assistant.start({
    from: { id: 1 },
    reply: async (...args) => replies.push(args)
  });

  assert.match(replies[0][0], /Current draft:/);
  assert.match(replies[1][0], /^<pre><code class="language-json">/);
  assert.equal(replies[1][1].parse_mode, 'HTML');
  assert.match(replies[1][0], /"sync"/);
});
