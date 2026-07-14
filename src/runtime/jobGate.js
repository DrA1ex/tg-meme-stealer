import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger } from '../core/logger.js';

export class JobGate {
  constructor(logger = getLogger('jobGate')) {
    this.runningKey = null;
    this.queue = [];
    this.keyCounts = new Map();
    this.taskContext = new AsyncLocalStorage();
    this.logger = logger;
    this.accepting = true;
    this.idleResolvers = [];
  }

  run(key, fn, options = {}) {
    const nestedJob = this.handleNestedRun(key, fn);
    if (nestedJob) return nestedJob;
    if (!this.accepting) return skippedJob(key, 'shutting_down');

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
        duplicateLocation: this.hasQueuedKey(key) ? 'queued' : 'running',
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
    const nestedJob = this.handleNestedRun(key, fn);
    if (nestedJob) return nestedJob;
    if (!this.accepting) return skippedJob(key, 'shutting_down');

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
    void Promise.resolve().then(() => this.execute(task));
  }

  async execute(task) {
    try {
      const result = await this.taskContext.run({ key: task.key }, async () => task.fn());
      this.finish(task);
      task.resolve(result);
    } catch (error) {
      this.finish(task);
      task.resolve({
        failed: true,
        error: error?.message || String(error)
      });
    }
  }

  finish(task) {
    this.deleteKey(task.key);
    this.runningKey = null;
    this.startNext();
    this.resolveIdle();
  }

  startNext() {
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  close() {
    if (!this.accepting) return;
    this.accepting = false;
    const queued = this.queue.splice(0);
    for (const task of queued) {
      this.deleteKey(task.key);
      task.resolve({
        failed: true,
        cancelled: true,
        error: 'Application shutting down'
      });
    }
    this.resolveIdle();
  }

  waitForIdle() {
    if (!this.runningKey && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  resolveIdle() {
    if (this.runningKey || this.queue.length > 0) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
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

  handleNestedRun(key, fn) {
    const nestedTask = this.taskContext.getStore();
    if (!nestedTask) return null;
    if (nestedTask.key === key) return inlineJob(key, fn);
    throw this.createNestedDeadlockError(key, nestedTask);
  }

  createNestedDeadlockError(key, nestedTask) {
    const message = 'Detected nested dead-lock, forbidden';
    const error = new Error(message);
    error.code = 'NESTED_DEADLOCK';
    error.attemptKey = key;
    error.currentTaskKey = nestedTask.key;

    this.logger.error(message, {
      attemptKey: key,
      currentTaskKey: nestedTask.key,
      currentRunningKey: this.runningKey || '',
      queueSize: this.queue.length
    });

    return error;
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

function inlineJob(key, fn) {
  let promise;
  try {
    promise = Promise.resolve(fn());
  } catch (error) {
    promise = Promise.resolve({
      failed: true,
      error: error?.message || String(error)
    });
  }

  return {
    status: 'running',
    key,
    promise: promise.catch((error) => ({
      failed: true,
      error: error?.message || String(error)
    }))
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
