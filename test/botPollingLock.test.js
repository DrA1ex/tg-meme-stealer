import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireBotPollingLock } from '../src/telegram/botPollingLock.js';

test('bot polling lock is exclusive and can be reacquired after release', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-lock-'));
  const lockPath = path.join(dir, 'polling.lock');
  const first = await acquireBotPollingLock(lockPath, process.pid);
  await assert.rejects(acquireBotPollingLock(lockPath, process.pid), { code: 'BOT_POLLING_LOCKED' });
  await first.release();
  const second = await acquireBotPollingLock(lockPath, process.pid);
  await second.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('bot polling lock replaces a stale owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-memes-lock-'));
  const lockPath = path.join(dir, 'polling.lock');
  await fs.writeFile(lockPath, '999999999:old\n');
  const lock = await acquireBotPollingLock(lockPath, process.pid);
  assert.match(await fs.readFile(lockPath, 'utf8'), new RegExp(`^${process.pid}:`));
  await lock.release();
  await fs.rm(dir, { recursive: true, force: true });
});
