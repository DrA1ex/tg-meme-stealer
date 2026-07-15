import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { MediaDownloader } from '../src/telegram/media.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('MediaDownloader.cleanupFiles deletes temporary media files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-'));
  const filePath = path.join(dir, 'media.jpg');
  await fs.writeFile(filePath, 'data');

  const downloader = new MediaDownloader({
    client: {},
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, throttle: { enabled: false } }
    }
  });

  assert.equal(await downloader.cleanupFiles([{ path: filePath }, { path: path.join(dir, 'missing.jpg') }]), 1);
  await assert.rejects(fs.access(filePath));
});

test('MediaDownloader.loadMessage passes numeric peer ids to mtcute', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getMessages: async (...args) => {
        calls.push(args);
        return [{ id: 10 }];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  assert.deepEqual(await downloader.loadMessage('-1001341205233', 10), { id: 10 });
  assert.deepEqual(calls, [[-1001341205233, [10]]]);
});

test('MediaDownloader streams media into unique per-attempt directories', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-stream-'));
  const client = {
    getMessages: async (_chatId, ids) => [{ id: ids[0], media: { fileSize: 4 } }],
    downloadAsNodeStream: () => Readable.from([Buffer.from('data')])
  };
  const downloader = new MediaDownloader({
    client,
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });
  const post = { chatId: -1001, messageId: 10, data: { media: [{ messageId: 10, mediaKind: 'photo' }] } };

  const [first, second] = await Promise.all([
    downloader.downloadPostMedia(post),
    downloader.downloadPostMedia(post)
  ]);

  assert.equal(first[0].bytes, 4);
  assert.equal(second[0].bytes, 4);
  assert.notEqual(first[0].tempDir, second[0].tempDir);
  assert.equal(await fs.readFile(first[0].path, 'utf8'), 'data');
  assert.equal(await fs.readFile(second[0].path, 'utf8'), 'data');
  await downloader.cleanupFiles([...first, ...second]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader aborts oversized streams and removes the partial attempt directory', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-limit-'));
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => [{ id: 10, media: {} }],
      downloadAsNodeStream: () => Readable.from([Buffer.alloc(8), Buffer.alloc(8)])
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 10, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });

  await assert.rejects(
    downloader.downloadPostMedia({ chatId: -1001, messageId: 10, data: { media: [{ messageId: 10, mediaKind: 'video' }] } }),
    { code: 'MEDIA_TOO_LARGE' }
  );
  assert.deepEqual(await fs.readdir(dir), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader rejects declared oversized media before starting a download', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-declared-'));
  let downloads = 0;
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => [{ id: 10, media: { fileSize: 101 } }],
      downloadAsNodeStream: () => { downloads += 1; throw new Error('must not download'); }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });

  await assert.rejects(
    downloader.downloadPostMedia({ chatId: -1001, messageId: 10, data: { media: [{ messageId: 10, mediaKind: 'video' }] } }),
    { code: 'MEDIA_TOO_LARGE' }
  );
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readdir(dir), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader removes stale publication directories but keeps unrelated files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-stale-'));
  const stale = path.join(dir, 'publication-stale');
  const fresh = path.join(dir, 'publication-fresh');
  const unrelated = path.join(dir, 'keep.txt');
  await fs.mkdir(stale);
  await fs.mkdir(fresh);
  await fs.writeFile(unrelated, 'keep');
  const now = Date.now();
  await fs.utimes(stale, new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));
  await fs.utimes(fresh, new Date(now), new Date(now));
  const downloader = new MediaDownloader({
    client: {},
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxAgeHours: 1, throttle: { enabled: false } }
    }
  });

  assert.equal(await downloader.cleanupStaleFiles(dir, now), 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['keep.txt', 'publication-fresh']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader removes an empty attempt directory when referenced media cannot be loaded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-empty-'));
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => []
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    },
    throttle: { wait: async () => {}, onFloodWait: async () => {} }
  });

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: { media: [{ messageId: 10, mediaKind: 'photo' }] }
  });
  const entries = await fs.readdir(dir);

  assert.deepEqual(files, []);
  assert.deepEqual(entries, []);
  await fs.rm(dir, { recursive: true, force: true });
});
