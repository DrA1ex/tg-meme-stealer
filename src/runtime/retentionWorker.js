import { getLogger } from '../core/logger.js';
import { JobGate } from './jobGate.js';

export class RetentionWorker {
  constructor({ scanner, jobGate = new JobGate() }) {
    this.scanner = scanner;
    this.jobGate = jobGate;
    this.logger = getLogger('retention-worker');
  }

  run(source = 'manual') {
    return this.jobGate.run('retention', () => this.execute(source));
  }

  async execute(source) {
    const startedAt = Date.now();
    this.logger.debug('Retention job started', { source });
    try {
      const prunedOld = await this.scanner.cleanupOldPosts();
      this.logger.info('Retention job finished', {
        source,
        prunedOld,
        durationMs: Date.now() - startedAt
      });
      return { source, prunedOld };
    } catch (error) {
      this.logger.error('Retention job failed', {
        source,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      });
      return {
        failed: true,
        source,
        error: error?.message || String(error)
      };
    }
  }
}
