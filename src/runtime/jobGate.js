import { getLogger } from '../core/logger.js';

export class JobGate {
  constructor(logger = getLogger('jobGate')) {
    this.runningKey = null;
    this.queue = [];
    this.keys = new Set();
    this.logger = logger;
  }

  run(key, fn) {
    if (this.keys.has(key)) {
      this.logger.warn('Job skipped', {
        key,
        reason: 'duplicate_job',
        runningKey: this.runningKey || '',
        queued: this.queue.length
      });
      return skippedJob(key, 'duplicate_job');
    }

    const task = createTask(key, fn);
    this.keys.add(key);

    if (this.runningKey) {
      this.queue.push(task);
      return jobStatus('scheduled', task);
    }

    this.start(task);
    return jobStatus('running', task);
  }

  runIfIdle(key, fn) {
    if (this.runningKey || this.queue.length > 0) {
      this.logger.warn('Job skipped', {
        key,
        reason: 'busy',
        runningKey: this.runningKey || '',
        queued: this.queue.length
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
        this.keys.delete(task.key);
        this.runningKey = null;
        this.startNext();
      });
  }

  startNext() {
    const next = this.queue.shift();
    if (next) this.start(next);
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
