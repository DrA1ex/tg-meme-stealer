import test from 'node:test';
import assert from 'node:assert/strict';
import { getValuesByPath, parseCount, parseMessagesToPosts, parseReactions, passesFilters } from '../src/core/postParser.js';

test('parseCount supports plain and compact counters', () => {
  assert.equal(parseCount('👍 42'), 42);
  assert.equal(parseCount('1.5k'), 1500);
  assert.equal(parseCount('2,1\u043a'), 2100);
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

test('parseMessagesToPosts filters target user and groups photo albums', () => {
  const messages = [
    message({ id: 10, groupedId: 'album-1', text: 'By Alice\ncaption', buttons: [['👍 8', '👎 1']] }),
    message({ id: 11, groupedId: 'album-1', text: '' }),
    message({ id: 12, userId: 999, text: 'By Bob', buttons: [['👍 100']] })
  ];

  const posts = parseMessagesToPosts(messages, { chatId: -1001, targetUserId: 123 });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].messageId, 10);
  assert.equal(posts[0].likes, 8);
  assert.equal(posts[0].dislikes, 1);
  assert.equal(posts[0].author, 'Alice');
  assert.equal(posts[0].data.media.length, 2);
  assert.equal(posts[0].data.images, undefined);
});

test('parseMessagesToPosts supports all mode, sender author and text-only posts', () => {
  const messages = [
    message({ id: 20, userId: 999, photo: false, text: 'plain post', buttons: [['👍 2']] })
  ];
  const senderById = new Map([[999, { id: 999, firstName: 'Bob', username: 'bob' }]]);

  const posts = parseMessagesToPosts(messages, {
    chatId: -1001,
    targetUserId: 123,
    sourceMode: 'all',
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
    targetUserId: 123,
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
      targetUserId: 123,
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

test('getValuesByPath expands array markers', () => {
  const values = getValuesByPath(
    { rows: [{ buttons: [{ text: 'a' }, { text: 'b' }] }] },
    'rows[].buttons[].text'
  );

  assert.deepEqual(values, ['a', 'b']);
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
