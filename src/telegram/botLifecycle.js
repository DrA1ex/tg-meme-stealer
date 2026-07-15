import { acquireBotPollingLock } from './botPollingLock.js';

export class BotLifecycle {
  constructor({
    getBot,
    pollingLockFile = null,
    logger,
    waitForIdle,
    fatalErrorHandler = null
  }) {
    this.getBot = getBot;
    this.pollingLockFile = pollingLockFile;
    this.logger = logger;
    this.waitForIdle = waitForIdle;
    this.fatalErrorHandler = fatalErrorHandler;
    this.launchPromise = null;
    this.pollingLock = null;
    this.releasePromise = null;
    this.stopping = false;
    this.failureReported = false;
  }

  setFatalErrorHandler(handler) {
    this.fatalErrorHandler = handler;
  }

  async launch() {
    if (this.launchPromise) return { started: true, reused: true };
    const bot = this.getBot();
    await bot.telegram.getMe();
    this.pollingLock = await acquireBotPollingLock(this.pollingLockFile);
    this.stopping = false;
    this.failureReported = false;

    try {
      this.launchPromise = Promise.resolve(bot.launch());
    } catch (error) {
      await this.releaseLock();
      throw error;
    }

    this.launchPromise.then(
      () => {
        if (!this.stopping) this.reportFatalError(new Error('Telegram bot polling stopped unexpectedly'));
      },
      (error) => {
        if (!this.stopping) this.reportFatalError(error);
      }
    ).finally(async () => {
      await this.releaseLock();
      this.launchPromise = null;
    });

    return { started: true };
  }

  reportFatalError(error) {
    if (this.failureReported) return;
    this.failureReported = true;
    this.logger.error('Bot polling failed', { error: error?.message || String(error) });
    try {
      this.fatalErrorHandler?.(error);
    } catch (handlerError) {
      this.logger.error('Fatal bot error handler failed', { error: handlerError?.message || String(handlerError) });
    }
  }

  async stop(signal = 'SIGTERM', timeoutMs = 30000) {
    this.stopping = true;
    const bot = this.getBot();
    const launchPromise = this.launchPromise;
    try {
      bot.stop(signal);
    } catch (error) {
      if (!isBotAlreadyStoppedError(error)) throw error;
    }
    await this.waitForIdle(timeoutMs);
    if (launchPromise) {
      const settled = await waitForSettlement(launchPromise, timeoutMs);
      if (!settled) {
        this.logger.warn('Bot polling did not settle before shutdown timeout; retaining polling lock until it actually stops', {
          timeoutMs
        });
        return;
      }
    }
    await this.releaseLock();
  }

  async releaseLock() {
    if (this.releasePromise) return this.releasePromise;
    const lock = this.pollingLock;
    this.pollingLock = null;
    if (!lock) return;
    this.releasePromise = (async () => {
      try {
        await lock.release();
      } catch (error) {
        this.logger.error('Failed to release bot polling lock', { error: error?.message || String(error) });
      } finally {
        this.releasePromise = null;
      }
    })();
    return this.releasePromise;
  }
}

function isBotAlreadyStoppedError(error) {
  return /bot is not running|not running/i.test(String(error?.message || error));
}


async function waitForSettlement(promise, timeoutMs) {
  let timeout;
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true
  );
  const expired = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 30000));
  });
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timeout);
  }
}
