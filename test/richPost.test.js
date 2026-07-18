import test from 'node:test';
import assert from 'node:assert/strict';
import { sendRichPost } from '../src/telegram/richPost.js';

test('sendRichPost sends albums atomically with the caption on the first media item', async () => {
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

  assert.deepEqual(calls.map((call) => call[0]), ['mediaGroup']);
  assert.equal(calls[0][1], 42);
  assert.deepEqual(calls[0][2], [
    { type: 'photo', media: { source: '/tmp/1.jpg' }, caption: 'Post 10 media=photo#10, video#11' },
    { type: 'video', media: { source: '/tmp/2.mp4' } }
  ]);
  assert.deepEqual(cleaned, ['/tmp/1.jpg', '/tmp/2.mp4']);
});

test('sendRichPost forwards transient media context to the downloader', async () => {
  const mediaContext = {
    source: 'setup-preview',
    sourceMessagesById: new Map([[10, { id: 10 }]])
  };
  let receivedContext = null;
  const mediaDownloader = {
    downloadPostMedia: async (_post, context) => {
      receivedContext = context;
      return [];
    },
    cleanupFiles: async () => {}
  };
  const telegram = {
    sendMessage: async () => ({ message_id: 1 })
  };

  await sendRichPost({
    telegram,
    chatId: 42,
    mediaDownloader,
    mediaContext,
    index: 0,
    templates: { publish: { postCaption: 'Post {{messageId}}' } },
    post: { chatId: -1001, messageId: 10, data: { media: [] } }
  });

  assert.equal(receivedContext, mediaContext);
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

test('sendRichPost keeps a single media file until Telegraf has finished reading it', { timeout: 2_000 }, async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-rich-post-single-'));
  const filePath = path.join(dir, 'media.jpg');
  await fs.writeFile(filePath, 'image');
  const canonicalFilePath = await fs.realpath(filePath);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let cleaned = false;

  const mediaDownloader = {
    downloadPostMedia: async () => [{ path: filePath, kind: 'photo', tempDir: dir }],
    cleanupFiles: async () => {
      cleaned = true;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  const telegram = {
    sendPhoto: async (_chatId, media) => {
      await delay(20);
      assert.equal(await fs.realpath(media.source), canonicalFilePath);
      assert.equal(await fs.readFile(media.source, 'utf8'), 'image');
      assert.equal(cleaned, false);
      return { message_id: 1 };
    }
  };

  const result = await sendRichPost({
    telegram,
    chatId: 42,
    mediaDownloader,
    index: 0,
    templates: { publish: { postCaption: 'Post {{messageId}}' } },
    post: { chatId: -1001, messageId: 10, data: { media: [{ mediaKind: 'photo', messageId: 10 }] } }
  });

  assert.deepEqual(result, { message_id: 1 });
  assert.equal(cleaned, true);
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});

test('sendRichPost keeps album files until Telegraf has finished building the media group', { timeout: 2_000 }, async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-rich-post-album-'));
  const firstPath = path.join(dir, 'first.jpg');
  const secondPath = path.join(dir, 'second.jpg');
  await Promise.all([fs.writeFile(firstPath, 'first'), fs.writeFile(secondPath, 'second')]);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const mediaDownloader = {
    downloadPostMedia: async () => [
      { path: firstPath, kind: 'photo', tempDir: dir },
      { path: secondPath, kind: 'photo', tempDir: dir }
    ],
    cleanupFiles: async () => fs.rm(dir, { recursive: true, force: true })
  };
  const telegram = {
    sendMediaGroup: async (_chatId, media) => {
      await delay(20);
      assert.equal(await fs.readFile(media[0].media.source, 'utf8'), 'first');
      assert.equal(await fs.readFile(media[1].media.source, 'utf8'), 'second');
      return [{ message_id: 1 }, { message_id: 2 }];
    }
  };

  await sendRichPost({
    telegram,
    chatId: 42,
    mediaDownloader,
    index: 0,
    templates: { publish: { postCaption: 'Post {{messageId}}' } },
    post: {
      chatId: -1001,
      messageId: 10,
      data: { media: [{ mediaKind: 'photo', messageId: 10 }, { mediaKind: 'photo', messageId: 11 }] }
    }
  });

  await assert.rejects(fs.access(firstPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(secondPath), { code: 'ENOENT' });
});

test('sendRichPost defers cleanup when the watchdog times out before Telegraf settles', { timeout: 2_000 }, async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-rich-post-timeout-'));
  const filePath = path.join(dir, 'media.jpg');
  await fs.writeFile(filePath, 'image');
  const canonicalFilePath = await fs.realpath(filePath);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let finishOperation;
  const operationFinished = new Promise((resolve) => { finishOperation = resolve; });
  let finishCleanup;
  const cleanupFinished = new Promise((resolve) => { finishCleanup = resolve; });

  const mediaDownloader = {
    downloadPostMedia: async () => [{ path: filePath, kind: 'photo', tempDir: dir }],
    cleanupFiles: async () => {
      await fs.rm(dir, { recursive: true, force: true });
      finishCleanup();
    }
  };
  const telegram = {
    sendPhoto: async (_chatId, media) => {
      try {
        await delay(30);
        assert.equal(await fs.realpath(media.source), canonicalFilePath);
        return { message_id: 1 };
      } finally {
        finishOperation();
      }
    }
  };

  await assert.rejects(
    sendRichPost({
      telegram,
      chatId: 42,
      mediaDownloader,
      operationTimeoutMs: 5,
      index: 0,
      templates: { publish: { postCaption: 'Post {{messageId}}' } },
      post: { chatId: -1001, messageId: 10, data: { media: [{ mediaKind: 'photo', messageId: 10 }] } }
    }),
    { code: 'TELEGRAM_OPERATION_TIMEOUT' }
  );

  assert.equal(await fs.readFile(filePath, 'utf8'), 'image');
  await operationFinished;
  await cleanupFinished;
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
