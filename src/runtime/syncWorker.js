import { createLogger } from '../core/logger.js';
import { JobGate } from './jobGate.js';

export class SyncWorker {
  constructor({ scanner, jobGate = new JobGate(), config }) {
    this.scanner = scanner;
    this.jobGate = jobGate;
    this.logger = createLogger(config, 'sync-worker');
    this.lastFinishedAt = null;
  }

  async sync(source = 'manual') {
    return source === 'admin'
      ? this.jobGate.runIfIdle('sync', () => this.execute('sync', source, () => this.scanner.sync()))
      : this.jobGate.run('sync', () => this.execute('sync', source, () => this.scanner.sync()));
  }

  async backfill(days, source = 'manual') {
    return source === 'admin'
      ? this.jobGate.runIfIdle(getBackfillKey(days), () => this.execute('backfill', source, () => this.scanner.backfill(days)))
      : this.jobGate.run(getBackfillKey(days), () => this.execute('backfill', source, () => this.scanner.backfill(days)));
  }

  async execute(operation, source, fn) {
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
      return {
        failed: true,
        operation,
        source,
        error: error?.message || String(error)
      };
    }
  }
}

function getBackfillKey(days) {
  return `backfill:${days || 'default'}`;
}
