import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { MediaDownloader } from '../src/telegram/media.js';
import { subscribeToErrorLogs } from '../src/core/logger.js';

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

test('MediaDownloader.loadMessage reads the source message through history with a numeric peer id', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (...args) => {
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
  assert.deepEqual(calls, [[-1001341205233, { limit: 2, offset: { id: 11, date: 0 } }]]);
});


test('MediaDownloader streams media into unique per-attempt directories', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-stream-'));
  const client = {
    getHistory: async () => [{ id: 10, media: { fileSize: 4 } }],
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
      getHistory: async () => [{ id: 10, media: {} }],
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
      getHistory: async () => [{ id: 10, media: { fileSize: 101 } }],
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
      getHistory: async () => []
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













test('MediaDownloader marks an unrecoverable source history lookup as publication-wide source failure', async () => {
  const downloader = new MediaDownloader({
    client: {
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


test('MediaDownloader logs FILE_REFERENCE_EXPIRED as ERROR and refreshes the source message once', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-refresh-location-'));
  const firstLocation = { type: 'photo', generation: 1, fileSize: 9 };
  const refreshedLocation = { type: 'photo', generation: 2, fileSize: 9 };
  const locations = [];
  const errors = [];
  let historyCalls = 0;
  const unsubscribe = subscribeToErrorLogs((event) => errors.push(event));
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (_peerId, params) => {
        historyCalls += 1;
        assert.deepEqual(params, { limit: 2, offset: { id: 11, date: 0 } });
        return [{ id: 10, media: historyCalls === 1 ? firstLocation : refreshedLocation }];
      },
      downloadAsNodeStream: (location) => {
        locations.push(location);
        if (location === firstLocation) {
          return Readable.from((async function* fail() {
            throw new Error('Telegram API error 400: FILE_REFERENCE_EXPIRED');
          })());
        }
        return Readable.from([Buffer.from('refreshed')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });

  try {
    const files = await downloader.downloadPostMedia({
      chatId: -1001,
      messageId: 10,
      data: { media: [{ messageId: 10, mediaKind: 'photo', fileSize: 9 }] }
    });

    assert.equal(historyCalls, 2);
    assert.deepEqual(locations, [firstLocation, refreshedLocation]);
    assert.equal(await fs.readFile(files[0].path, 'utf8'), 'refreshed');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].level, 'error');
    assert.equal(errors[0].fields.errorCode, 'FILE_REFERENCE_EXPIRED');
    await downloader.cleanupFiles(files);
  } finally {
    unsubscribe();
    await fs.rm(dir, { recursive: true, force: true });
  }
});



test('MediaDownloader batches nearby publication message lookups through source history', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (peerId, params) => {
        calls.push({ peerId, params });
        return [105, 104, 103, 102, 101].map((id) => ({ id, media: { type: 'photo', marker: id } }));
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const context = await downloader.preparePublicationMediaContext([
    { chatId: -1001, messageId: 105, data: { media: [{ messageId: 105, mediaKind: 'photo' }] } },
    { chatId: -1001, messageId: 103, data: { media: [{ messageId: 103, mediaKind: 'photo' }] } },
    { chatId: -1001, messageId: 101, data: { media: [{ messageId: 101, mediaKind: 'photo' }] } }
  ]);

  assert.deepEqual(calls, [{
    peerId: -1001,
    params: { limit: 5, offset: { id: 106, date: 0 } }
  }]);
  assert.deepEqual([...context.sourceMessagesByChatId.get('-1001').keys()].sort((a, b) => b - a), [105, 103, 101]);
  assert.equal(context.sourceMessagesComplete, true);
});

test('MediaDownloader splits distant publication messages into bounded history batches', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (peerId, params) => {
        calls.push({ peerId, params });
        if (params.offset.id === 301) {
          return [
            { id: 300, media: { type: 'photo' } },
            { id: 250, media: { type: 'photo' } }
          ];
        }
        return [{ id: 100, media: { type: 'photo' } }];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const messages = await downloader.loadMessagesViaHistoryBatched(-1001, [300, 250, 100]);

  assert.deepEqual([...messages.keys()].sort((a, b) => b - a), [300, 250, 100]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.params), [
    { limit: 51, offset: { id: 301, date: 0 } },
    { limit: 2, offset: { id: 101, date: 0 } }
  ]);
});

test('MediaDownloader retains its attempt directory until a timed-out background stream settles', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-read-timeout-'));
  let operationFinished;
  const finished = new Promise((resolve) => { operationFinished = resolve; });
  const downloader = new MediaDownloader({
    client: {
      getHistory: async () => [{ id: 10, media: { type: 'photo', fileSize: 9 } }],
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
      data: { media: [{ messageId: 10, mediaKind: 'photo', fileSize: 9 }] }
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

test('MediaDownloader uses transient setup messages without an extra history lookup', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-setup-preview-'));
  const location = { type: 'photo', marker: 'setup-fresh-location', fileSize: 7 };
  let historyCalls = 0;
  const downloader = new MediaDownloader({
    client: {
      getHistory: async () => {
        historyCalls += 1;
        throw new Error('setup preview must not refetch a message it already has');
      },
      downloadAsNodeStream: (actualLocation) => {
        assert.equal(actualLocation, location);
        return Readable.from([Buffer.from('preview')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: { media: [{ messageId: 10, mediaKind: 'photo' }] }
  }, {
    source: 'setup-preview',
    sourceMessagesById: new Map([[10, { id: 10, media: location }]])
  });

  assert.equal(historyCalls, 0);
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'preview');
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader refreshes a transient setup message only when its media reference already expired', async () => {
  const { Readable } = await import('node:stream');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-media-setup-refresh-'));
  const staleLocation = { type: 'photo', marker: 'setup-stale-location', fileSize: 7 };
  const refreshedLocation = { type: 'photo', marker: 'setup-refreshed-location', fileSize: 7 };
  let historyCalls = 0;
  const downloader = new MediaDownloader({
    client: {
      getHistory: async () => {
        historyCalls += 1;
        return [{ id: 10, media: refreshedLocation }];
      },
      downloadAsNodeStream: (location) => {
        if (location === staleLocation) {
          return Readable.from((async function* expired() {
            throw new Error('Telegram API error 400: FILE_REFERENCE_EXPIRED');
          })());
        }
        assert.equal(location, refreshedLocation);
        return Readable.from([Buffer.from('preview')]);
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: dir, mediaMaxBytes: 100, mediaMaxAgeHours: 24, throttle: { enabled: false } }
    }
  });

  const files = await downloader.downloadPostMedia({
    chatId: -1001,
    messageId: 10,
    data: { media: [{ messageId: 10, mediaKind: 'photo' }] }
  }, {
    source: 'setup-preview',
    sourceMessagesById: new Map([[10, { id: 10, media: staleLocation }]])
  });

  assert.equal(historyCalls, 1);
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'preview');
  await downloader.cleanupFiles(files);
  await fs.rm(dir, { recursive: true, force: true });
});

test('MediaDownloader fetches arbitrary publication message IDs through one direct getMessages call', async () => {
  const directCalls = [];
  let historyCalls = 0;
  const downloader = new MediaDownloader({
    client: {
      getMessages: async (peerId, ids) => {
        directCalls.push({ peerId, ids });
        return [
          { id: 300, media: { marker: 300 } },
          null,
          { id: 100, media: { marker: 100 } }
        ];
      },
      getHistory: async () => { historyCalls += 1; return []; }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const messages = await downloader.loadMessagesBatched('-1001', [100, 300, 250]);

  assert.deepEqual(directCalls, [{ peerId: -1001, ids: [300, 250, 100] }]);
  assert.deepEqual([...messages.keys()].sort((a, b) => b - a), [300, 100]);
  assert.equal(historyCalls, 0);
});

test('MediaDownloader refreshes the peer and retries direct message lookup once', async () => {
  let directCalls = 0;
  const resolved = [];
  let historyCalls = 0;
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => {
        directCalls += 1;
        if (directCalls === 1) throw new Error('Telegram API error 400: CHANNEL_INVALID');
        return [{ id: 10, media: { marker: 'direct-after-refresh' } }];
      },
      resolvePeer: async (...args) => resolved.push(args),
      getHistory: async () => { historyCalls += 1; return []; }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const messages = await downloader.loadMessagesBatched(-1001, [10]);

  assert.equal(directCalls, 2);
  assert.deepEqual(resolved, [[-1001, true]]);
  assert.equal(messages.get(10)?.media?.marker, 'direct-after-refresh');
  assert.equal(historyCalls, 0);
});

test('MediaDownloader disables broken direct lookup for a peer and reuses authoritative history fallback', async () => {
  let directCalls = 0;
  let resolveCalls = 0;
  const historyCalls = [];
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => {
        directCalls += 1;
        throw new Error('Telegram API error 400: CHANNEL_INVALID');
      },
      resolvePeer: async () => { resolveCalls += 1; },
      getHistory: async (peerId, params) => {
        historyCalls.push({ peerId, params });
        return [{ id: 10, media: { marker: 'history' } }];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const first = await downloader.loadMessagesBatched(-1001, [10]);
  const second = await downloader.loadMessagesBatched(-1001, [10]);

  assert.equal(first.get(10)?.media?.marker, 'history');
  assert.equal(second.get(10)?.media?.marker, 'history');
  assert.equal(directCalls, 2);
  assert.equal(resolveCalls, 1);
  assert.equal(historyCalls.length, 2);
});

test('MediaDownloader treats missing IDs in a completed history range as authoritative', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (peerId, params) => {
        calls.push({ peerId, params });
        return [
          { id: 105, media: { marker: 105 } },
          { id: 103, media: { marker: 103 } },
          { id: 101, media: { marker: 101 } }
        ];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const messages = await downloader.loadMessagesViaHistoryBatched(-1001, [105, 104, 103, 102, 101]);

  assert.deepEqual([...messages.keys()].sort((a, b) => b - a), [105, 103, 101]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { limit: 5, offset: { id: 106, date: 0 } });
});

test('MediaDownloader paginates history only until the requested range becomes authoritative', async () => {
  const calls = [];
  const pages = [
    [{ id: 105, media: {} }, { id: 104, media: {} }],
    [{ id: 103, media: {} }, { id: 101, media: {} }]
  ];
  const downloader = new MediaDownloader({
    client: {
      getHistory: async (peerId, params) => {
        calls.push({ peerId, params });
        return pages.shift() || [];
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  const messages = await downloader.loadMessagesViaHistoryBatched(-1001, [105, 103, 101]);

  assert.deepEqual([...messages.keys()].sort((a, b) => b - a), [105, 103, 101]);
  assert.deepEqual(calls.map((call) => call.params), [
    { limit: 5, offset: { id: 106, date: 0 } },
    { limit: 3, offset: { id: 104, date: 0 } }
  ]);
});

test('MediaDownloader splits direct getMessages lookups into Telegram-sized batches', async () => {
  const calls = [];
  const downloader = new MediaDownloader({
    client: {
      getMessages: async (peerId, ids) => {
        calls.push({ peerId, ids });
        return ids.map((id) => ({ id, media: { marker: id } }));
      }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });
  const ids = Array.from({ length: 205 }, (_, index) => index + 1);

  const messages = await downloader.loadMessagesBatched(-1001, ids);

  assert.deepEqual(calls.map((call) => call.ids.length), [100, 100, 5]);
  assert.equal(messages.size, 205);
  assert.equal(messages.get(205)?.media?.marker, 205);
  assert.equal(messages.get(1)?.media?.marker, 1);
});

test('MediaDownloader does not hide definitive source errors behind history fallback', async () => {
  let historyCalls = 0;
  const downloader = new MediaDownloader({
    client: {
      getMessages: async () => { throw new Error('Telegram API error 400: CHANNEL_PRIVATE'); },
      getHistory: async () => { historyCalls += 1; return []; }
    },
    config: {
      logging: { logLevel: 'silent' },
      sync: { mediaDir: os.tmpdir(), throttle: { enabled: false } }
    }
  });

  await assert.rejects(
    downloader.loadMessagesBatched(-1001, [10]),
    (error) => error.telegramFailureScope === 'source' && /CHANNEL_PRIVATE/.test(error.message)
  );
  assert.equal(historyCalls, 0);
});
