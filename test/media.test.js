import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MediaDownloader } from '../src/telegram/media.js';

test('MediaDownloader.cleanupFiles deletes temporary media files', async () => {
  const dir = await fs.mkdtemp('/private/tmp/tg-memes-media-');
  const filePath = path.join(dir, 'media.jpg');
  await fs.writeFile(filePath, 'data');

  const downloader = new MediaDownloader({
    client: {},
    config: {
      logging: { level: 'silent' },
      sync: { mediaDir: dir, throttle: { enabled: false } }
    }
  });

  assert.equal(await downloader.cleanupFiles([{ path: filePath }, { path: path.join(dir, 'missing.jpg') }]), 1);
  await assert.rejects(fs.access(filePath));
});
