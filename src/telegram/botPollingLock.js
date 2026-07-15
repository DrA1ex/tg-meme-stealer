import fs from 'node:fs/promises';
import path from 'node:path';

export async function acquireBotPollingLock(lockPath, pid = process.pid) {
  if (!lockPath) return { path: null, async release() {} };
  const resolvedPath = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const token = `${pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(resolvedPath, 'wx', 0o600);
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return {
        path: resolvedPath,
        async release() {
          try {
            const current = (await fs.readFile(resolvedPath, 'utf8')).trim();
            if (current === token) await fs.rm(resolvedPath, { force: true });
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readLock(resolvedPath);
      const currentPid = Number(String(current).split(':')[0]);
      if (Number.isInteger(currentPid) && isProcessAlive(currentPid)) {
        const lockError = new Error(`Telegram bot polling is already owned by process ${currentPid}`);
        lockError.code = 'BOT_POLLING_LOCKED';
        lockError.pid = currentPid;
        throw lockError;
      }
      await fs.rm(resolvedPath, { force: true });
    }
  }

  throw new Error(`Unable to acquire Telegram bot polling lock: ${resolvedPath}`);
}

async function readLock(lockPath) {
  try {
    return await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
