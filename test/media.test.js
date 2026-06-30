import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { MediaDownloader } from '../src/telegram/media.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('MediaDownloader.cleanupFiles deletes temporary media files', async () => {
  const dir = await fs.mkdtemp('/private/tmp/tg-memes-media-');
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
      sync: { mediaDir: '/private/tmp', throttle: { enabled: false } }
    }
  });

  assert.deepEqual(await downloader.loadMessage('-1001341205233', 10), { id: 10 });
  assert.deepEqual(calls, [[-1001341205233, [10]]]);
});
