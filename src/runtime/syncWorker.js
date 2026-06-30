import { createLogger } from '../core/logger.js';

export class SyncWorker {
  constructor({ scanner, config }) {
    this.scanner = scanner;
    this.logger = createLogger(config, 'sync-worker');
    this.running = false;
    this.lastFinishedAt = null;
  }

  async sync(source = 'manual') {
    return this.run('sync', source, () => this.scanner.sync());
  }

  async backfill(days, source = 'manual') {
    return this.run('backfill', source, () => this.scanner.backfill(days));
  }

  async run(operation, source, fn) {
    if (this.running) {
      this.logger.warn('Sync job skipped: worker already running', { operation, source });
      return {
        skipped: true,
        reason: 'sync_worker_busy',
        operation,
        source
      };
    }

    this.running = true;
    const startedAt = Date.now();
    this.logger.info('Sync job started', { operation, source });
    try {
      const result = await fn();
      this.lastFinishedAt = new Date();
      this.logger.info('Sync job finished', {
        operation,
        source,
        durationMs: Date.now() - startedAt,
        skipped: Boolean(result?.skipped)
      });
      return result;
    } catch (error) {
      this.logger.error('Sync job failed', {
        operation,
        source,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
