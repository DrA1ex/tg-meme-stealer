import { getLogger } from '../core/logger.js';
import { sleepWithSignal } from '../telegram/rateLimitUtils.js';
import { JobGate } from './jobGate.js';

export class SyncWorker {
  constructor({ scanner, jobGate = new JobGate(), config, notifyAdmin = null, signal = null, sleepFn = sleepWithSignal }) {
    this.scanner = scanner;
    this.jobGate = jobGate;
    this.config = config;
    this.notifyAdmin = notifyAdmin;
    this.signal = signal;
    this.sleepFn = sleepFn;
    this.logger = getLogger('sync-worker');
    this.lastFinishedAt = null;
    this.lastSuccessfulAt = null;
    this.publicationPaused = false;
    this.pauseReason = '';
  }

  setAdminNotifier(notifyAdmin) {
    this.notifyAdmin = notifyAdmin;
  }

  canPublish() {
    return !this.publicationPaused;
  }

  getPublicationPauseReason() {
    return this.pauseReason;
  }

  async sync(source = 'manual', options = {}) {
    const task = () => this.executeWithRetry('sync', source, () => this.scanner.sync({ force: Boolean(options.force) }));
    return source === 'admin'
      ? this.jobGate.runIfIdle('sync', task)
      : this.jobGate.run('sync', task);
  }

  async backfill(days, source = 'manual', options = {}) {
    const task = () => this.executeWithRetry('backfill', source, () => this.scanner.backfill(days, { force: Boolean(options.force) }));
    return source === 'admin'
      ? this.jobGate.runIfIdle(getBackfillKey(days), task)
      : this.jobGate.run(getBackfillKey(days), task);
  }

  async executeWithRetry(operation, source, fn) {
    const startedAt = Date.now();
    const maxRetries = nonNegativeInteger(this.config.sync?.maxRetries, 3);
    const retryBaseMs = positiveNumber(this.config.sync?.retryBaseMs, 2_000);
    const retryMaxMs = positiveNumber(this.config.sync?.retryMaxMs, 60_000);
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      this.logger.debug('Sync job attempt started', { operation, source, attempt: attempt + 1, maxAttempts: maxRetries + 1 });
      try {
        const result = await fn();
        if (result?.failed) throw resultToError(result);
        this.lastFinishedAt = new Date();
        this.lastSuccessfulAt = this.lastFinishedAt;
        if (operation === 'sync') {
          this.publicationPaused = false;
          this.pauseReason = '';
          if (result?.reconciliationBlocked) {
            const ratio = Number(result.missingRatio || 0);
            const threshold = Number(this.config.sync?.maxMissingRatio ?? 0.3);
            await this.safeNotifyAdmin([
              'Synchronization completed, but deleted-post reconciliation was skipped for safety.',
              `Reason: ${result.reconciliationReason || 'incomplete scan'}.`,
              `Missing recent posts: ${result.missingRecent || 0}/${result.expectedRecent || 0} (${(ratio * 100).toFixed(1)}%; threshold ${(threshold * 100).toFixed(1)}%).`,
              '',
              'No local posts were deleted. Inspect the source chat and run /sync --force only when this difference is expected.'
            ].join('\n'));
          }
        }
        this.logger.debug('Sync job finished', {
          operation,
          source,
          durationMs: Date.now() - startedAt,
          attempts: attempt + 1,
          skipped: Boolean(result?.skipped)
        });
        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
        const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(attempt, 10)));
        this.logger.warn('Sync job attempt failed; retrying', {
          operation,
          source,
          attempt: attempt + 1,
          retryInMs: delayMs,
          error: error?.message || String(error)
        });
        await this.sleepFn(delayMs, this.signal);
      }
    }

    this.lastFinishedAt = new Date();
    const errorText = lastError?.message || String(lastError);
    this.logger.error('Sync job failed after retries', {
      operation,
      source,
      durationMs: Date.now() - startedAt,
      attempts: maxRetries + 1,
      error: errorText
    });

    if (operation === 'sync') {
      this.publicationPaused = true;
      this.pauseReason = `Synchronization failed after ${maxRetries + 1} attempts: ${errorText}`;
      await this.safeNotifyAdmin([
        'Automatic publication has been paused because synchronization failed.',
        `Error: ${errorText}`,
        '',
        'Run /sync to retry manually. Use /sync --force only when you intentionally want to accept a large deletion reconciliation.',
        'After a successful sync, use /publish <selection> if a missed publication must be sent immediately.'
      ].join('\n'));
    }

    return {
      failed: true,
      operation,
      source,
      attempts: maxRetries + 1,
      error: errorText,
      publicationPaused: operation === 'sync'
    };
  }

  async safeNotifyAdmin(message) {
    if (typeof this.notifyAdmin !== 'function') return;
    try {
      await this.notifyAdmin(message);
    } catch (error) {
      this.logger.error('Failed to notify admin about sync failure', { error: error?.message || String(error) });
    }
  }
}

function getBackfillKey(days) {
  return `backfill:${days || 'default'}`;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resultToError(result) {
  const error = new Error(result.error || 'Sync operation failed');
  error.result = result;
  return error;
}
