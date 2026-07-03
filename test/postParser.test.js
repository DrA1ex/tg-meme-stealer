import test from 'node:test';
import assert from 'node:assert/strict';
import { debugParseMessage, getPathTrace, getValuesByPath, parseCount, parseCountDetails, parseMessagesToPosts, parseReactions, passesFilters } from '../src/core/postParser.js';

test('parseCount supports plain and compact counters', () => {
  assert.equal(parseCount('👍 42'), 42);
  assert.equal(parseCount('1.5k'), 1500);
  assert.equal(parseCount('2,1\u043a'), 2100);
  assert.deepEqual(parseCountDetails('1.5k'), {
    input: '1.5k',
    normalized: '1.5k',
    matched: true,
    number: 1.5,
    suffix: 'k',
    multiplier: 1000,
    result: 1500
  });
});

test('parseReactions reads likes and dislikes from inline buttons', () => {
  const reactions = parseReactions({
    rows: [
      { buttons: [{ text: '👍 12' }, { text: '👎 3' }] },
      { buttons: [{ text: '🔥 2' }] }
    ]
  });

  assert.deepEqual(reactions, { likes: 14, dislikes: 3 });
});

test('parseMessagesToPosts filters sender through parsing rules and groups photo albums', () => {
  const messages = [
    message({ id: 10, groupedId: 'album-1', text: 'By Alice\ncaption', buttons: [['👍 8', '👎 1']] }),
    message({ id: 11, groupedId: 'album-1', text: '' }),
    message({ id: 12, userId: 999, text: 'By Bob', buttons: [['👍 100']] })
  ];

  const posts = parseMessagesToPosts(messages, {
    chatId: -1001,
    parsing: {
      filters: [{ source: 'message', path: 'senderId', transform: 'equals', value: 123 }]
    }
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].messageId, 10);
  assert.equal(posts[0].likes, 8);
  assert.equal(posts[0].dislikes, 1);
  assert.equal(posts[0].author, 'Alice');
  assert.equal(posts[0].data.media.length, 2);
  assert.equal(posts[0].data.images, undefined);
});

test('parseMessagesToPosts supports sender author and text-only posts', () => {
  const messages = [
    message({ id: 20, userId: 999, photo: false, text: 'plain post', buttons: [['👍 2']] })
  ];
  const senderById = new Map([[999, { id: 999, firstName: 'Bob', username: 'bob' }]]);

  const posts = parseMessagesToPosts(messages, {
    chatId: -1001,
    senderById,
    parsing: {
      filters: [{ source: 'message', transform: 'hasContent' }],
      author: [{ source: 'sender', path: 'firstName', transform: 'trim' }]
    }
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, 'Bob');
  assert.deepEqual(posts[0].data.media, []);
});

test('parseMessagesToPosts supports videos and configurable reaction extractors', () => {
  const messages = [
    message({
      id: 30,
      photo: false,
      video: true,
      text: 'Author: Carol',
      buttons: [['like=1.2k', 'dislike=4']]
    })
  ];

  const posts = parseMessagesToPosts(messages, {
    chatId: -1001,
    parsing: {
      filters: [{ source: 'message', transform: 'hasMedia' }],
      author: [{ source: 'message', path: 'message', regex: 'Author:\\s*(.+)$', group: 1 }],
      likes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '^like=([\\d.,k]+)', group: 1, transform: 'count' }],
      dislikes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: 'dislike=([\\d.,k]+)', group: 1, transform: 'count' }]
    }
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, 'Carol');
  assert.equal(posts[0].likes, 1200);
  assert.equal(posts[0].dislikes, 4);
  assert.equal(posts[0].data.media[0].mediaKind, 'video');
});

test('parseMessagesToPosts supports mtcute-shaped messages', () => {
  const posts = parseMessagesToPosts(
    [
      {
        id: 40,
        sender: { id: 123, firstName: 'Dora', username: 'dora' },
        groupedId: null,
        date: new Date('2026-06-01T00:00:00.000Z'),
        text: 'By Dora\nmtcute post',
        media: { type: 'photo', id: 4000 },
        markup: { buttons: [[{ text: '👍 5' }, { text: '👎 2' }]] }
      }
    ],
    {
      chatId: -1001,
      parsing: {
        filters: [{ source: 'message', transform: 'hasContent' }],
        author: [{ source: 'message', path: 'text', regex: '(?:^|\\n)By\\s+(.+?)(?:\\n|$)', group: 1 }]
      }
    }
  );

  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, 'Dora');
  assert.equal(posts[0].likes, 5);
  assert.equal(posts[0].dislikes, 2);
  assert.equal(posts[0].data.media[0].mediaKind, 'photo');
});

test('parseMessagesToPosts should do reaction fallback', () => {
  const posts = parseMessagesToPosts(
    [message({ id: 52, text: 'By Eve', buttons: [['👍 31']] })],
    {
      chatId: -1001,
      parsing: {
        likes: [{
          source: 'message',
          path: 'missing.rows[].buttons[].text',
          regex: '👍\\s*(\\d+)',
          group: 1,
          transform: 'count',
          aggregate: 'sum'
        }]
      }
    }
  );

  assert.equal(posts[0].likes, 31);
});

test('passesFilters supports regex and bool transforms', () => {
  assert.equal(
    passesFilters(
      { message: { message: '#meme hello' } },
      [{ source: 'message', path: 'message', regex: '#meme', transform: 'bool' }]
    ),
    true
  );
  assert.equal(
    passesFilters(
      { message: { message: 'hello' } },
      [{ source: 'message', path: 'message', regex: '#meme', transform: 'bool' }]
    ),
    false
  );
});

test('passesFilters supports contains, arrays, equals and negation', () => {
  assert.equal(
    passesFilters(
      { message: { message: 'hello /skip' } },
      [{ source: 'message', path: 'message', transform: 'contains', value: '/skip', negate: true }]
    ),
    false
  );
  assert.equal(
    passesFilters(
      { message: { message: 'hello' } },
      [{ source: 'message', path: 'message', transform: 'contains', values: ['/skip', '#ignore'], negate: true }]
    ),
    true
  );
  assert.equal(
    passesFilters(
      { sender: { id: 123 } },
      [{ source: 'sender', path: 'id', transform: 'equals', value: 123 }]
    ),
    true
  );
});

test('debugParseMessage explains negated contains filters', () => {
  const debug = debugParseMessage(
    message({ id: 49, text: 'hello /skip' }),
    {
      chatId: -1001,
      parsing: {
        filters: [{ source: 'message', path: 'message', transform: 'contains', value: '/skip', negate: true }]
      }
    }
  );

  assert.equal(debug.filterPassed, false);
  assert.equal(debug.filters.rules[0].matchedBeforeNegate, true);
  assert.equal(debug.filters.rules[0].negated, true);
  assert.equal(debug.filters.rules[0].passed, false);
  assert.deepEqual(debug.filters.rules[0].values[0].transformDetails, {
    input: 'hello /skip',
    values: ['/skip'],
    caseSensitive: false,
    result: true
  });
});

test('debugParseMessage explains filters and extractor transforms', () => {
  const debug = debugParseMessage(
    message({ id: 50, text: 'Author: Eve #meme', buttons: [['like=12', 'dislike=4']] }),
    {
      chatId: -1001,
      parsing: {
        filters: [{ source: 'message', path: 'message', regex: '#meme', transform: 'bool' }],
        author: [{ source: 'message', path: 'message', regex: 'Author:\\s*(\\w+)', group: 1, transform: 'trim' }],
        likes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '^like=(\\d+)', group: 1, transform: 'count' }],
        dislikes: [{ source: 'message', path: 'replyMarkup.rows[].buttons[].text', regex: '^dislike=(\\d+)', group: 1, transform: 'count' }]
      }
    }
  );

  assert.equal(debug.shouldRead, true);
  assert.equal(debug.filterPassed, true);
  assert.equal(debug.filters.rules[0].values[0].extracted, '#meme');
  assert.equal(debug.filters.rules[0].values[0].transformed, true);
  assert.equal(debug.extractors.author.selected, 'Eve');
  assert.equal(debug.extractors.likes.selected, 12);
  assert.deepEqual(debug.extractors.likes.rules[0].acceptedValues, [{
    valueIndex: 0,
    input: 'like=12',
    extracted: '12',
    transformed: 12
  }]);
  assert.equal(debug.extractors.likes.rules[0].subtotal, 12);
  assert.equal(debug.extractors.likes.rules[0].runningTotal, 12);
  assert.deepEqual(debug.extractors.likes.rules[0].values[0].transformDetails, {
    input: '12',
    normalized: '12',
    matched: true,
    number: 12,
    suffix: '',
    multiplier: 1,
    result: 12
  });
  assert.equal(debug.extractors.dislikes.selected, 4);
  assert.equal(debug.result.matched, true);
});

test('debugParseMessage explains aggregate sum for count extractors', () => {
  const debug = debugParseMessage(
    message({ id: 51, text: 'By Eve', buttons: [['👍 12', '🔥 3', '👎 4']] }),
    {
      chatId: -1001,
      parsing: {
        likes: [{
          source: 'message',
          path: 'replyMarkup.rows[].buttons[].text',
          regex: '(?:👍|🔥)\\s*(\\d+)',
          group: 1,
          transform: 'count',
          aggregate: 'sum'
        }]
      }
    }
  );

  assert.equal(debug.extractors.likes.selected, 15);
  assert.deepEqual(debug.extractors.likes.rules[0].acceptedValues.map((value) => value.transformed), [12, 3]);
  assert.equal(debug.extractors.likes.rules[0].subtotal, 15);
  assert.equal(debug.extractors.likes.rules[0].runningTotal, 15);
  assert.equal(debug.extractors.likes.rules[0].aggregate, 'sum');
  assert.match(debug.extractors.likes.rules[0].aggregateBehavior, /continue/);
});

test('debugParseMessage explains fallback when extractor path has no values', () => {
  const debug = debugParseMessage(
    message({ id: 52, text: 'By Eve', buttons: [['👍 31']] }),
    {
      chatId: -1001,
      parsing: {
        likes: [{
          source: 'message',
          path: 'missing.rows[].buttons[].text',
          regex: '👍\\s*(\\d+)',
          group: 1,
          transform: 'count',
          aggregate: 'sum'
        }]
      }
    }
  );

  assert.equal(debug.extractors.likes.selected, 31);
  assert.equal(debug.extractors.likes.fallbackUsed, true);
  assert.equal(debug.extractors.likes.fallbackReason, 'extractor rules produced no numeric values');
  assert.equal(debug.extractors.likes.fallbackSource, 'parseReactions(message.markup || message.replyMarkup)');
  assert.equal(debug.extractors.likes.rules[0].pathMatched, false);
  assert.equal(debug.extractors.likes.rules[0].valuesCount, 0);
});

test('debugParseMessage omits regex trace fields when rule has no regex', () => {
  const debug = debugParseMessage(
    message({ id: 53, text: 'plain text' }),
    {
      chatId: -1001,
      parsing: {
        filters: [{ source: 'message', transform: 'hasContent' }]
      }
    }
  );

  const value = debug.filters.rules[0].values[0];
  assert.equal(Object.hasOwn(value, 'regex'), false);
  assert.equal(Object.hasOwn(value, 'regexGroup'), false);
  assert.equal(Object.hasOwn(value, 'regexMatched'), false);
  assert.equal(value.transform, 'hasContent');
  assert.equal(value.transformed, true);
});

test('getValuesByPath expands array markers', () => {
  const values = getValuesByPath(
    { rows: [{ buttons: [{ text: 'a' }, { text: 'b' }] }] },
    'rows[].buttons[].text'
  );

  assert.deepEqual(values, ['a', 'b']);
});

test('getValuesByPath reads nested button arrays with a simple path', () => {
  const root = { markup: { buttons: [[{ text: '👍 1' }, { text: '🔥 2' }]] } };

  assert.deepEqual(getValuesByPath(root, 'markup.buttons[].text'), ['👍 1', '🔥 2']);
  assert.deepEqual(getValuesByPath(root, 'markup.buttons[][].text'), ['👍 1', '🔥 2']);
});

test('getPathTrace explains each path segment', () => {
  const trace = getPathTrace({ markup: { buttons: [[{ text: '👍 1' }]] } }, 'markup.buttons[].text');

  assert.deepEqual(trace.map((item) => [item.part, item.inputCount, item.outputCount]), [
    ['markup', 1, 1],
    ['buttons[]', 1, 1],
    ['text', 1, 1]
  ]);
  assert.deepEqual(trace[2].outputTypes, ['string']);
});

function message({ id, userId = 123, groupedId = null, text = '', buttons = [], photo = true, video = false }) {
  return {
    id,
    senderId: userId,
    groupedId,
    date: 1717200000 + id,
    message: text,
    photo: photo ? { id: id * 1000 } : undefined,
    media: video ? { className: 'MessageMediaDocument', document: { id: id * 2000, mimeType: 'video/mp4' } } : undefined,
    replyMarkup: buttons.length
      ? { rows: buttons.map((row) => ({ buttons: row.map((button) => ({ text: button })) })) }
      : undefined
  };
}
