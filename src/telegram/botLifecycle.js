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
    try {
      bot.stop(signal);
    } catch (error) {
      if (!isBotAlreadyStoppedError(error)) throw error;
    }
    await this.waitForIdle(timeoutMs);
    await this.releaseLock();
  }

  async releaseLock() {
    const lock = this.pollingLock;
    this.pollingLock = null;
    if (!lock) return;
    try {
      await lock.release();
    } catch (error) {
      this.logger.error('Failed to release bot polling lock', { error: error?.message || String(error) });
    }
  }
}

function isBotAlreadyStoppedError(error) {
  return /bot is not running|not running/i.test(String(error?.message || error));
}
