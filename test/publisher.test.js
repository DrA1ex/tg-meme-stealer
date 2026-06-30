import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionPublisher } from '../src/telegram/publisher.js';

test('SelectionPublisher.waitForIdle waits for active handlers', async () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });
  publisher.activeHandlers = 1;

  const wait = publisher.waitForIdle(100);
  let settled = false;
  wait.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  publisher.activeHandlers = 0;
  publisher.resolveIdle();
  await wait;

  assert.equal(settled, true);
});

test('SelectionPublisher.waitForIdle times out', async () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });
  publisher.activeHandlers = 1;

  await publisher.waitForIdle(1);
  assert.equal(publisher.activeHandlers, 1);
});

test('SelectionPublisher.launchBot does not wait for polling promise', () => {
  const publisher = new SelectionPublisher({
    repository: {},
    mediaDownloader: {},
    setupAssistant: null,
    config: config()
  });
  let launched = false;
  publisher.bot = {
    launch: () => {
      launched = true;
      return new Promise(() => {});
    }
  };

  publisher.launchBot();

  assert.equal(launched, true);
});

function config() {
  return {
    telegram: {
      botToken: 'token',
      adminId: 1,
      publishChannelId: -1001
    },
    logging: { level: 'silent' },
    publish: { dryRun: true },
    templates: {}
  };
}
