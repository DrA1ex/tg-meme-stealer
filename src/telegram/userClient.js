import fs from 'node:fs';
import path from 'node:path';
import { TelegramClient } from '@mtcute/node';
import { encodeQR } from 'qr';

export function createUserClient(config) {
  const sessionFile = path.resolve(config.telegram.sessionFile);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

  return new TelegramClient({
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    storage: sessionFile
  });
}

export async function startUserClient(config) {
  const sessionFile = path.resolve(config.telegram.sessionFile);
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`mtcute session not found: ${sessionFile}. Run: npm run session`);
  }
  const client = createUserClient(config);
  await client.start();
  return client;
}

export async function createSession(config) {
  const client = createUserClient(config);
  await client.start({
    qrCodeHandler: (url, expires) => {
      clearTerminal();
      writeTerminal('Scan this QR code in Telegram: Settings > Devices > Link Desktop Device');
      writeTerminal(`Expires: ${expires.toISOString()}`);
      writeTerminal(encodeQR(url, 'ascii'));
    },
    password: () => client.input('2FA password: ')
  });

  await client.destroy();
  return path.resolve(config.telegram.sessionFile);
}

function clearTerminal() {
  process.stdout.write('\x1Bc');
}

function writeTerminal(value) {
  process.stdout.write(`${value}\n`);
}
