import assert from 'node:assert/strict';
import test from 'node:test';
import { configureLogger } from '../src/core/logger.js';
import { SelectionPublisher } from '../src/telegram/publisher.js';

configureLogger({ logging: { logLevel: 'SILENT' } });

test('unknown post errors are retried three times and then the post is skipped', async () => {
  const state = createHarness(1);
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    state.attempts += 1;
    throw new Error('unclassified');
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 1 });
  assert.equal(state.attempts, 4);
  assert.equal(state.failedPosts.length, 1);
  assert.equal(state.failedPosts[0].error.telegramFailureClass, 'unknown_exhausted');
  assert.equal(state.finished.status, 'published');
});

test('four consecutive exhausted unknown post errors fail the publication', async () => {
  const state = createHarness(5);
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    state.attempts += 1;
    throw new Error('unclassified');
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.equal(result.failed, true);
  assert.equal(result.consecutiveFailures, 4);
  assert.equal(state.attempts, 16);
  assert.equal(state.failedPosts.length, 4);
  assert.equal(state.failedPublication?.id, 77);
  assert.equal(state.finished, null);
});

test('known permanent post errors are skipped without contributing to the unknown-error streak', async () => {
  const state = createHarness(5);
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    state.attempts += 1;
    const error = new Error('Bad Request: caption is too long');
    error.response = { error_code: 400, description: 'Bad Request: caption is too long' };
    throw error;
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 5 });
  assert.equal(state.attempts, 5);
  assert.equal(state.failedPublication, null);
  assert.equal(state.finished.status, 'published');
});

test('a successful post resets the consecutive unknown-error streak', async () => {
  const state = createHarness(7);
  const perPositionAttempts = new Map();
  state.publisher.publishPost = async (_post, index, onBeforeSend) => {
    await onBeforeSend();
    const position = index + 1;
    perPositionAttempts.set(position, (perPositionAttempts.get(position) || 0) + 1);
    if (position !== 4) throw new Error('unclassified');
    return { message_id: 100 + position };
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 6 });
  assert.equal(state.failedPublication, null);
  assert.equal(state.sentPosts.length, 1);
  assert.equal(state.sentPosts[0].position, 4);
});

test('lease loss before a post side effect stops the worker without rewriting request state', async () => {
  const state = createHarness(1, {
    markPublicationPostSending: async () => {
      throw Object.assign(new Error('lease stolen'), { code: 'PUBLICATION_LEASE_LOST' });
    }
  });
  let updatedError = false;
  state.repository.updatePublicationError = async () => { updatedError = true; };
  const requests = [state.request];
  state.repository.getNextPublicationRequest = async () => requests.shift() || null;
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    assert.fail('Telegram side effect must not start after lease loss');
  };

  const result = await state.publisher.processPublicationQueue();

  assert.deepEqual(result, { processed: 0 });
  assert.equal(updatedError, false);
  assert.equal(state.finished, null);
});

function createHarness(postCount, repositoryOverrides = {}) {
  const posts = Array.from({ length: postCount }, (_, index) => ({
    chatId: -1001,
    messageId: index + 1,
    author: `Author ${index + 1}`,
    text: `Post ${index + 1}`,
    likes: 1,
    dislikes: 0,
    data: { media: [] }
  }));
  const request = {
    id: 77,
    key: 'publish:test',
    status: 'running',
    data: { selection: { key: 'best.test', title: 'Test', posts } }
  };
  const state = {
    attempts: 0,
    failedPosts: [],
    sentPosts: [],
    finished: null,
    failedPublication: null
  };
  const repository = {
    listPublicationPosts: async () => [],
    markPublicationPostSending: async () => {},
    markPublicationPostPending: async () => {},
    markPublicationPostFailed: async (payload) => state.failedPosts.push(payload),
    recordPublicationPost: async (payload) => state.sentPosts.push(payload),
    finishPublication: async (_id, payload) => { state.finished = payload; },
    failPublication: async (id, error) => { state.failedPublication = { id, error }; },
    ...repositoryOverrides
  };
  const publisher = new SelectionPublisher({
    repository,
    mediaDownloader: { downloadPostMedia: async () => [], cleanupFiles: async () => {} },
    setupAssistant: null,
    config: {
      telegram: { botToken: 'token', adminId: 1, publishChannelId: -1002, sourceChatId: -1001 },
      logging: { logLevel: 'silent' },
      publish: {
        dryRun: false,
        postMaxRetries: 3,
        maxConsecutivePostFailures: 3,
        retryBaseMs: 1,
        retryMaxMs: 1
      },
      rateLimit: { telegramOperationTimeoutMs: 1000 },
      schedule: { timezone: 'UTC' },
      templates: { publish: { postCaption: '{{text}}' } }
    }
  });
  publisher.safeNotifyAdmin = async () => true;
  return { ...state, publisher, repository, request, get attempts() { return state.attempts; }, set attempts(v) { state.attempts = v; }, get failedPosts() { return state.failedPosts; }, get sentPosts() { return state.sentPosts; }, get finished() { return state.finished; }, get failedPublication() { return state.failedPublication; } };
}

test('an unexpected request failure is deferred and does not block the next queued publication', async () => {
  const requests = [
    { id: 1, key: 'publish:poison', attemptCount: 0 },
    { id: 2, key: 'publish:healthy', attemptCount: 0 }
  ];
  const deferredRequests = [];
  const processedRequests = [];
  const publisher = new SelectionPublisher({
    repository: {
      getNextPublicationRequest: async () => requests.shift() || null,
      deferPublicationRetry: async (id, ownerId, error, options) => {
        deferredRequests.push({ id, ownerId, error, options });
        return { failed: false, attemptCount: 1 };
      },
      renewPublicationLease: async () => true
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      telegram: { botToken: 'token', adminId: 1, publishChannelId: -1002, sourceChatId: -1001 },
      logging: { logLevel: 'silent' },
      publish: { dryRun: false, requestMaxRetries: 3, retryBaseMs: 1, retryMaxMs: 1, workerLeaseMs: 1000 },
      schedule: { timezone: 'UTC' },
      templates: {}
    }
  });
  publisher.processPublicationRequest = async (request) => {
    processedRequests.push(request.id);
    if (request.id === 1) throw new Error('unexpected request bug');
    return { published: true };
  };

  const result = await publisher.processPublicationQueue();

  assert.deepEqual(result, { processed: 1 });
  assert.deepEqual(processedRequests, [1, 2]);
  assert.equal(deferredRequests.length, 1);
  assert.equal(deferredRequests[0].id, 1);
  assert.equal(deferredRequests[0].options.countAttempt, true);
  assert.equal(deferredRequests[0].options.maxAttempts, 3);
});

test('unexpected network failures are deferred without consuming the request retry budget', async () => {
  const calls = [];
  const publisher = new SelectionPublisher({
    repository: {
      deferPublicationRetry: async (id, ownerId, error, options) => {
        calls.push({ id, ownerId, error, options });
        return { failed: false, attemptCount: 0 };
      }
    },
    mediaDownloader: {},
    setupAssistant: null,
    config: {
      telegram: { botToken: 'token', adminId: 1, publishChannelId: -1002, sourceChatId: -1001 },
      logging: { logLevel: 'silent' },
      publish: { dryRun: false, requestMaxRetries: 3, retryBaseMs: 1, retryMaxMs: 1 },
      schedule: { timezone: 'UTC' },
      templates: {}
    }
  });
  publisher.safeNotifyAdmin = async () => true;
  const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

  const result = await publisher.handleUnexpectedPublicationFailure({ id: 9, key: 'publish:network', attemptCount: 100 }, error);

  assert.deepEqual(result, { deferred: true, failed: false, network: true });
  assert.equal(calls[0].options.countAttempt, false);
  assert.equal(calls[0].options.maxAttempts, Number.POSITIVE_INFINITY);
});
