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

  await assert.rejects(
    downloader.downloadPostMedia({
      chatId: -1001,
      messageId: 10,
      data: { media: [{ messageId: 10, mediaKind: 'photo' }] }
    }),
    { code: 'SOURCE_MEDIA_NOT_FOUND' }
  );
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader uses stored portable file ids without reloading the source message', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-file-id-'));
  const locations = [];
  const now = Date.parse('2026-07-18T06:00:00.000Z');
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => assert.fail('portable media must not call getMessages'),
      getHistory: async () => assert.fail('fresh portable media must not call getHistory'),
      downloadAsNodeStream: (location) => {
        locations.push(location);
        return Readable.from([Buffer.from('portable')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: {
        mediaDir: dir,
        mediaMaxBytes: 100,
        mediaMaxAgeHours: 24,
        mediaFileIdMaxAgeHours: 6,
        throttle: { enabled: false }
      }
    },
    nowFn: () => now
  });

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: {
      media: [{
        messageId: 10,
        mediaKind: 'photo',
        fileId: 'portable-file-id',
        fileIdCapturedAt: new Date(now - 60_000).toISOString(),
        fileSize: 8
      }]
    }
  });

  assert.deepEqual(locations, ['portable-file-id']);
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'portable');
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader treats legacy portable file ids without a capture timestamp as stale', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-legacy-file-id-'));
  const locations = [];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async () => [{
        id: 10,
        media: { type: 'photo', fileId: 'fresh-file-id', fileSize: 6 }
      }],
      downloadAsNodeStream: (location) => {
        locations.push(location);
        return Readable.from([Buffer.from('legacy')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: {
        mediaDir: dir,
        mediaMaxBytes: 100,
        mediaMaxAgeHours: 24,
        mediaFileIdMaxAgeHours: 6,
        throttle: { enabled: false }
      }
    }
  });
  const media = {
    messageId: 10,
    mediaKind: 'photo',
    fileId: 'legacy-file-id',
    fileSize: 6
  };

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: { media: [media] }
  });

  assert.equal(locations.length, 1);
  assert.equal(typeof locations[0], 'object');
  assert.equal(locations[0].fileId, 'fresh-file-id');
  assert.equal(media.fileId, 'fresh-file-id');
  assert.match(media.fileIdCapturedAt, /^\d{4}-\d{2}-\d{2}T/);
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader refreshes legacy or stale portable file ids before download', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-stale-file-id-'));
  const now = Date.parse('2026-07-18T06:00:00.000Z');
  const locations = [];
  const historyCalls = [];
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => assert.fail('stale portable media must use the stable history path'),
      getHistory: async (peerId, params) => {
        historyCalls.push({ peerId, params });
        return [{
          id: 10,
          media: {
            type: 'photo',
            fileId: 'refreshed-file-id',
            fileSize: 9
          }
        }];
      },
      downloadAsNodeStream: (location) => {
        locations.push(location);
        return Readable.from([Buffer.from('refreshed')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: {
        mediaDir: dir,
        mediaMaxBytes: 100,
        mediaMaxAgeHours: 24,
        mediaFileIdMaxAgeHours: 6,
        throttle: { enabled: false }
      }
    },
    nowFn: () => now
  });
  const media = {
    messageId: 10,
    mediaKind: 'photo',
    fileId: 'stale-file-id',
    fileIdCapturedAt: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
    fileSize: 9
  };

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: { media: [media] }
  });

  assert.deepEqual(historyCalls, [{
    peerId: -1001,
    params: { limit: 2, offset: { id: 11, date: 0 } }
  }]);
  assert.deepEqual(locations, [{
    type: 'photo',
    fileId: 'refreshed-file-id',
    fileSize: 9
  }]);
  assert.equal(media.fileId, 'refreshed-file-id');
  assert.equal(media.fileIdCapturedAt, new Date(now).toISOString());
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'refreshed');
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader falls back to history when direct channel lookup returns CHANNEL_INVALID', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => {
        calls.push('getMessages');
        throw new Error('Telegram API error 400: CHANNEL_INVALID');
      },
      getHistory: async (peerId, params) => {
        calls.push({ peerId, params });
        return [{ id: 10, media: { type: 'photo' } }];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const message = await downloader.loadMessage('-1001341205233', 10);

  assert.equal(message.id, 10);
  assert.equal(calls[0], 'getMessages');
  assert.deepEqual(calls[1], {
    peerId: -1001341205233,
    params: { limit: 2, offset: { id: 11, date: 0 } }
  });
});

test('MediaDownloader marks an unrecoverable legacy source lookup as publication-wide source failure', async () => {
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => { throw new Error('CHANNEL_INVALID'); },
      getHistory: async () => { throw new Error('CHANNEL_PRIVATE'); }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  await assert.rejects(
    downloader.loadMessage(-1001, 10),
    (error) => error.telegramFailureScope === 'source' && /CHANNEL_PRIVATE/.test(error.message)
  );
});

test('MediaDownloader refreshes an expired portable file reference through source history', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-refresh-file-id-'));
  const locations = [];
  const now = Date.parse('2026-07-18T06:00:00.000Z');
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => assert.fail('expired portable media should refresh directly through history'),
      getHistory: async (_peerId, params) => {
        assert.deepEqual(params, { limit: 2, offset: { id: 11, date: 0 } });
        return [{ id: 10, media: { type: 'photo', fileSize: 9 } }];
      },
      downloadAsNodeStream: (location) => {
        locations.push(location);
        if (location === 'expired-file-id') {
          return Readable.from((async function* fail() {
            throw new Error('Telegram API error 400: FILE_REFERENCE_EXPIRED');
          })());
        }
        return Readable.from([Buffer.from('refreshed')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: {
        mediaDir: dir,
        mediaMaxBytes: 100,
        mediaMaxAgeHours: 24,
        mediaFileIdMaxAgeHours: 6,
        throttle: { enabled: false }
      }
    },
    nowFn: () => now
  });

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: {
      media: [{
        messageId: 10,
        mediaKind: 'photo',
        fileId: 'expired-file-id',
        fileIdCapturedAt: new Date(now - 60_000).toISOString(),
        fileSize: 9
      }]
    }
  });

  assert.equal(locations[0], 'expired-file-id');
  assert.deepEqual(locations[1], { type: 'photo', fileSize: 9 });
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'refreshed');
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader retains its attempt directory until a timed-out background stream settles', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-read-timeout-'));
  let operationFinished;
  const finished = new Promise((resolve) => { operationFinished = resolve; });
  const downloader = new MediaDownloader({
    client: {
      downloadAsNodeStream: () => Readable.from((async function* delayed() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield Buffer.from('late-data');
        operationFinished();
      })())
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    },
    throttle: { wait: async () => {}, operationTimeoutMs: 5 }
  });

  await assert.rejects(
    downloader.downloadPostMedia({
      chatId: -1001,
      messageId: 10,
      data: { media: [{ messageId: 10, mediaKind: 'photo', fileId: 'portable-file-id', fileIdCapturedAt: new Date().toISOString(), fileSize: 9 }] }
    }),
    (error) => error.code === 'TELEGRAM_OPERATION_TIMEOUT' && error.indeterminate === false
  );

  assert.equal((await fs.readdir(dir)).length, 1);
  await finished;
  await waitUntil(async () => (await fs.readdir(dir)).length === 0);
  await fs.rm(dir, { recursive: true, force: true });
});

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true before timeout');
}
