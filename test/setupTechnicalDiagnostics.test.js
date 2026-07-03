import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactRawMessage,
  clampDiagnosticIndex,
  findDiagnosticMessages,
  formatAuthorFields,
  formatCompactRawMessageScreen,
  formatFieldScan,
  formatMessageBrowser,
  formatMessageShape,
  formatParserTrace,
  formatReactionFields,
  formatTechnicalDiagnosticsOverview,
  formatTechnicalMessagePreview
} from '../src/telegram/setup/technicalDiagnostics.js';

test('technical overview and field diagnostics summarize loaded setup samples', () => {
  const messages = [
    message({ id: 1, text: 'By: Alice\n#meme', buttons: ['👍 5'], nativeReactions: [{ reaction: '🔥', count: 9 }] }),
    message({ id: 2, text: 'plain text', buttons: ['👎 2'], sender: { id: 77, firstName: 'Other' } }),
    message({ id: 3, text: '', photo: false })
  ];
  const draft = draftConfig();

  assert.match(formatTechnicalDiagnosticsOverview({ messages, draft, baseConfig: baseConfig(), sample: { maxLimit: 10, cacheAgeMs: 61_000, exhausted: false } }), /Loaded: 3\/10/);
  assert.match(formatFieldScan(messages), /replyMarkup\.rows\[\]\.buttons\[\]\.text/);
  assert.match(formatMessageShape(messages), /With button counters: 2\/3/);
  assert.match(formatReactionFields(messages), /👍: 1 label\(s\), total 5/);
  assert.match(formatAuthorFields(messages), /Top sender: 42/);
});

test('diagnostic search modes find matched, rejected, zero-like, button and native-reaction messages', () => {
  const messages = [
    message({ id: 1, text: 'By: Alice\n#meme', buttons: ['👍 5'], nativeReactions: [{ reaction: '🔥', count: 9 }] }),
    message({ id: 2, text: 'plain text without author', buttons: [], sender: {} }),
    message({ id: 3, text: '', photo: false })
  ];
  const draft = draftConfig();
  const base = baseConfig();

  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'matched').map((item) => item.message.id), [1, 2]);
  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'rejected').map((item) => item.message.id), [3]);
  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'unknown_author').map((item) => item.message.id), [2]);
  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'zero_likes').map((item) => item.message.id), [2]);
  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'buttons').map((item) => item.message.id), [1]);
  assert.deepEqual(findDiagnosticMessages(messages, draft, base, 'native_reactions').map((item) => item.message.id), [1]);
  assert.equal(clampDiagnosticIndex(99, 2), 1);
  assert.equal(clampDiagnosticIndex(-10, 2), 0);
});

test('parser trace explains concrete matched and rejected messages', () => {
  const messages = [
    message({ id: 1, text: 'By: Alice\n#meme', buttons: ['👍 5'] }),
    message({ id: 2, text: '', photo: false })
  ];
  const draft = draftConfig();
  const base = baseConfig();

  const matched = formatParserTrace({ messages, draft, baseConfig: base, mode: 'matched', index: 0 });
  const rejected = formatParserTrace({ messages, draft, baseConfig: base, mode: 'rejected', index: 0 });
  const missing = formatParserTrace({ messages: [], draft, baseConfig: base, mode: 'matched', index: 0 });

  assert.match(matched, /Reason: parsed post in sample/);
  assert.match(matched, /author=Alice/);
  assert.match(matched, /Selected: 5/);
  assert.match(rejected, /matched=false/);
  assert.match(missing, /No message matched trace mode/);
});

test('raw compact diagnostics render JSON as an HTML code block and escape raw values', () => {
  const messages = [
    message({ id: 1, text: '<b>By: Alice</b>\n#meme', buttons: ['👍 5'], nativeReactions: [{ reaction: '🔥', count: 9 }] }),
    message({ id: 2, text: '<script>alert(1)</script>', buttons: ['👎 2'] })
  ];
  const html = formatCompactRawMessageScreen({ messages, draft: draftConfig(), baseConfig: baseConfig(), mode: 'buttons', index: 0 });
  const compact = buildCompactRawMessage(messages[0]);

  assert.match(html, /<pre><code class="language-json">\{/);
  assert.match(html, /&lt;b&gt;By: Alice&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.deepEqual(compact.replyMarkup.rows, ['👍 5']);
  assert.deepEqual(compact.reactions, [{ emoji: '🔥', count: 9 }]);
});

test('message browser and single-message preview expose match state and compact fields', () => {
  const messages = [
    message({ id: 1, text: 'By: Alice\n#meme', buttons: ['👍 5'] }),
    message({ id: 2, text: 'By: Bob\nno reaction' })
  ];
  const draft = draftConfig();
  const base = baseConfig();

  const browser = formatMessageBrowser({ messages, draft, baseConfig: base, page: 999, pageSize: 1 });
  const preview = formatTechnicalMessagePreview({ message: messages[0], draft, baseConfig: base });
  const missing = formatTechnicalMessagePreview({ message: null, draft, baseConfig: base });

  assert.match(browser, /Page 2\/2/);
  assert.match(browser, /#2 · ✓ matched/);
  assert.match(preview, /Message preview · #1/);
  assert.match(preview, /matched=true/);
  assert.match(preview, /buttons=\["👍 5"\]/);
  assert.match(missing, /Message is not available/);
});

function draftConfig() {
  return {
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      author: [{ source: 'message', path: 'message', regex: 'By:\\s*(\\w+)', group: 1, transform: 'trim' }],
      likes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '👍\\s*(\\d+)', group: 1, transform: 'count', aggregate: 'sum' }],
      dislikes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '👎\\s*(\\d+)', group: 1, transform: 'count', aggregate: 'sum' }]
    }
  };
}

function baseConfig() {
  return { telegram: { sourceChatId: -1001 }, parsing: {} };
}

function message({ id, text = 'Post', buttons = [], nativeReactions = [], photo = true, sender = { id: 42, firstName: 'Source', username: 'source_bot' } } = {}) {
  return {
    id,
    date: 1717200000 + Number(id || 0),
    message: text,
    text,
    sender,
    senderId: sender?.id,
    photo: photo ? { id: Number(id || 1) * 1000 } : undefined,
    nativeReactions,
    replyMarkup: buttons.length
      ? { rows: [ { buttons: buttons.map((button) => ({ text: button })) } ] }
      : undefined
  };
}
