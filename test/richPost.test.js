import test from 'node:test';
import assert from 'node:assert/strict';
import { sendRichPost } from '../src/telegram/richPost.js';

test('sendRichPost sends first media with caption and does not use media groups', async () => {
  const calls = [];
  const cleaned = [];
  const telegram = {
    sendPhoto: async (...args) => calls.push(['photo', ...args]),
    sendVideo: async (...args) => calls.push(['video', ...args]),
    sendMessage: async (...args) => calls.push(['message', ...args]),
    sendMediaGroup: async (...args) => calls.push(['mediaGroup', ...args])
  };
  const mediaDownloader = {
    downloadPostMedia: async () => [
      { path: '/tmp/1.jpg', kind: 'photo' },
      { path: '/tmp/2.mp4', kind: 'video' }
    ],
    cleanupFiles: async (files) => cleaned.push(...files.map((file) => file.path))
  };

  await sendRichPost({
    telegram,
    chatId: 42,
    mediaDownloader,
    index: 0,
    templates: {
      publish: {
        postCaption: 'Post {{messageId}} media={{mediaSummary}}'
      }
    },
    post: {
      chatId: -1001,
      messageId: 10,
      author: 'Alice',
      text: 'By Alice',
      likes: 1,
      dislikes: 0,
      data: {
        media: [
          { mediaKind: 'photo', messageId: 10 },
          { mediaKind: 'video', messageId: 11 }
        ]
      }
    }
  });

  assert.deepEqual(calls.map((call) => call[0]), ['photo', 'video']);
  assert.equal(calls[0][3].caption, 'Post 10 media=photo#10, video#11');
  assert.equal(calls[1][3], undefined);
  assert.deepEqual(cleaned, ['/tmp/1.jpg', '/tmp/2.mp4']);
});

test('sendRichPost cleans media files when sending fails', async () => {
  const cleaned = [];
  const telegram = {
    sendPhoto: async () => {
      throw new Error('send failed');
    }
  };
  const mediaDownloader = {
    downloadPostMedia: async () => [{ path: '/tmp/1.jpg', kind: 'photo' }],
    cleanupFiles: async (files) => cleaned.push(...files.map((file) => file.path))
  };

  await assert.rejects(
    sendRichPost({
      telegram,
      chatId: 42,
      mediaDownloader,
      index: 0,
      templates: { publish: { postCaption: 'Post {{messageId}}' } },
      post: { chatId: -1001, messageId: 10, data: { media: [{ mediaKind: 'photo', messageId: 10 }] } }
    }),
    /send failed/
  );

  assert.deepEqual(cleaned, ['/tmp/1.jpg']);
});
