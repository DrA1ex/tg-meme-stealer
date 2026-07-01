import { getLogger } from '../core/logger.js';

export class JobGate {
  constructor(logger = getLogger('jobGate')) {
    this.runningKey = null;
    this.queue = [];
    this.keyCounts = new Map();
    this.logger = logger;
  }

  run(key, fn, options = {}) {
    if (this.hasKey(key)) {
      if (options.queueIfRunning && this.runningKey === key && !this.hasQueuedKey(key)) {
        const task = createTask(key, fn);
        this.queue.push(task);
        this.addKey(key);
        return jobStatus('scheduled', task);
      }

      this.logger.warn('Job enqueue skipped', {
        attemptKey: key,
        reason: 'duplicate_job',
        duplicateKey: key,
        duplicateLocation: this.runningKey === key ? 'running' : 'queued',
        currentRunningKey: this.runningKey || '',
        queueSize: this.queue.length
      });
      return skippedJob(key, 'duplicate_job');
    }

    const task = createTask(key, fn);
    this.addKey(key);

    if (this.runningKey) {
      this.queue.push(task);
      return jobStatus('scheduled', task);
    }

    this.start(task);
    return jobStatus('running', task);
  }

  runIfIdle(key, fn) {
    if (this.runningKey || this.queue.length > 0) {
      this.logger.warn('Job enqueue skipped', {
        attemptKey: key,
        reason: 'busy',
        currentRunningKey: this.runningKey || '',
        queueSize: this.queue.length
      });
      return skippedJob(key, 'busy', 'busy');
    }
    return this.run(key, fn);
  }

  start(task) {
    this.runningKey = task.key;
    Promise.resolve()
      .then(task.fn)
      .then((result) => task.resolve(result))
      .catch((error) => {
        task.resolve({
          failed: true,
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.deleteKey(task.key);
        this.runningKey = null;
        this.startNext();
      });
  }

  startNext() {
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  hasQueuedKey(key) {
    return this.queue.some((task) => task.key === key);
  }

  hasKey(key) {
    return this.keyCounts.has(key);
  }

  addKey(key) {
    this.keyCounts.set(key, (this.keyCounts.get(key) || 0) + 1);
  }

  deleteKey(key) {
    const count = this.keyCounts.get(key) || 0;
    if (count <= 1) {
      this.keyCounts.delete(key);
      return;
    }
    this.keyCounts.set(key, count - 1);
  }
}

function createTask(key, fn) {
  let resolve;
  const promise = new Promise((taskResolve) => {
    resolve = taskResolve;
  });
  return { key, fn, promise, resolve };
}

function jobStatus(status, task) {
  return {
    status,
    key: task.key,
    promise: task.promise
  };
}

function skippedJob(key, reason, status = 'skipped') {
  return {
    status,
    key,
    reason,
    promise: Promise.resolve({ skipped: true, reason, key })
  };
}
