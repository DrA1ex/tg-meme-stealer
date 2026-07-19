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



test('publication prepares source messages once and passes the shared media context to every post', async () => {
  const state = createHarness(2);
  const mediaContext = {
    source: 'scheduled-publication',
    sourceMessagesByChatId: new Map(),
    sourceMessagesComplete: true
  };
  let prepareCalls = 0;
  state.publisher.mediaDownloader.preparePublicationMediaContext = async (posts, options) => {
    prepareCalls += 1;
    assert.deepEqual(posts, state.request.data.selection.posts);
    assert.deepEqual(options, { source: 'scheduled-publication' });
    return mediaContext;
  };
  state.publisher.publishPost = async (_post, index, onBeforeSend, _signal, _onRetryableError, actualContext) => {
    assert.equal(actualContext, mediaContext);
    await onBeforeSend();
    return { message_id: 100 + index };
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 0 });
  assert.equal(prepareCalls, 1);
  assert.equal(state.sentPosts.length, 2);
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

test('source-scoped CHANNEL_INVALID stops the whole publication after the first affected post', async () => {
  const state = createHarness(5);
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    state.attempts += 1;
    const error = new Error('Telegram API error 400: CHANNEL_INVALID');
    error.response = { error_code: 400, description: 'CHANNEL_INVALID' };
    error.telegramFailureScope = 'source';
    throw error;
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.equal(result.failed, true);
  assert.equal(result.scope, 'source');
  assert.equal(result.position, 1);
  assert.equal(state.attempts, 1);
  assert.equal(state.failedPosts.length, 0);
  assert.equal(state.failedPublication.id, 77);
  assert.equal(state.finished, null);
});

test('confirmed Telegram delivery stops as uncertain when the delivery checkpoint cannot be written', async () => {
  let uncertain = null;
  const state = createHarness(1, {
    markPublicationPostDelivered: async () => { throw new Error('sqlite disk I/O error'); },
    markPublicationPostSent: async () => {},
    markPublicationUncertain: async (id, _owner, error) => { uncertain = { id, error }; }
  });
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    return { message_id: 555 };
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.equal(result.uncertain, true);
  assert.equal(result.deliveryConfirmed, true);
  assert.equal(uncertain.id, 77);
  assert.equal(state.failedPosts.length, 0);
  assert.equal(state.sentPosts.length, 0);
  assert.equal(state.finished, null);
});

test('a delivered database checkpoint is finalized after restart without resending Telegram media', async () => {
  const post = { chatId: -1001, messageId: 1, author: 'A', text: 'Post', likes: 1, dislikes: 0, data: { media: [] } };
  let rowState = 'delivered';
  let telegramSends = 0;
  let finalized = 0;
  let finished = null;
  const repository = {
    listPublicationPosts: async () => [{
      publicationId: 77, chatId: '-1001', messageId: 1, position: 1,
      botMessageId: 555, sendState: rowState
    }],
    markPublicationPostSent: async () => { rowState = 'sent'; finalized += 1; },
    finishPublication: async (_id, payload) => { finished = payload; }
  };
  const publisher = new SelectionPublisher({
    repository,
    mediaDownloader: { downloadPostMedia: async () => [], cleanupFiles: async () => {} },
    setupAssistant: null,
    config: {
      telegram: { botToken: 'token', adminId: 1, publishChannelId: -1002, sourceChatId: -1001 },
      logging: { logLevel: 'silent' },
      publish: { dryRun: false },
      rateLimit: { telegramOperationTimeoutMs: 1000 },
      schedule: { timezone: 'UTC' },
      templates: { publish: { postCaption: '{{text}}' } }
    }
  });
  publisher.publishPost = async () => { telegramSends += 1; };

  const result = await publisher.processPublicationRequest({
    id: 77,
    key: 'publish:test',
    status: 'running',
    data: { selection: { key: 'best.test', title: 'Test', posts: [post] } }
  });

  assert.deepEqual(result, { published: true, skippedPosts: 0 });
  assert.equal(finalized, 1);
  assert.equal(telegramSends, 0);
  assert.equal(finished.status, 'published');
});

test('header_delivered recovery advances to running without sending a duplicate header', async () => {
  const state = createHarness(1, {
    markPublicationRunning: async () => { state.runningTransitions += 1; },
    listPublicationPosts: async () => [{ position: 1, sendState: 'sent' }]
  });
  state.runningTransitions = 0;
  state.request.status = 'header_delivered';
  state.publisher.bot.telegram.sendMessage = async () => assert.fail('header must not be sent again');
  state.publisher.publishPost = async () => assert.fail('already sent post must not be sent again');

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 0 });
  assert.equal(state.runningTransitions, 1);
});

test('post network failure is durably deferred without consuming post or request retry limits', async () => {
  let deferred = null;
  const state = createHarness(1, {
    deferPublicationRetry: async (id, ownerId, error, options) => {
      deferred = { id, ownerId, error, options };
      return { failed: false, nextAttemptAt: '2026-07-16T00:00:00.000Z' };
    }
  });
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    throw Object.assign(new Error('Telegram offline'), { code: 'ENETUNREACH' });
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.equal(result.deferred, true);
  assert.equal(result.network, true);
  assert.equal(deferred.id, 77);
  assert.equal(deferred.options.countAttempt, false);
  assert.equal(deferred.options.status, 'running');
  assert.equal(state.failedPosts.length, 0);
});

test('Bot API retry_after returns the post to pending before the next delivery attempt', async () => {
  const transitions = [];
  const state = createHarness(1, {
    markPublicationPostSending: async () => transitions.push('sending'),
    markPublicationPostPending: async () => transitions.push('pending'),
    markPublicationPostDelivered: async () => transitions.push('delivered'),
    markPublicationPostSent: async () => transitions.push('sent')
  });
  let attempts = 0;
  state.publisher.botRateLimiter = {
    wait: async () => {},
    noteRateLimit: async () => true
  };
  state.publisher.bot.telegram = {
    sendMessage: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Too Many Requests: retry after 1');
        error.response = {
          error_code: 429,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 }
        };
        throw error;
      }
      return { message_id: 501 };
    }
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(transitions, ['sending', 'pending', 'sending', 'delivered', 'sent']);
});

test('a missing temporary file stops the publication as an infrastructure failure', async () => {
  const state = createHarness(3);
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    await onBeforeSend();
    state.attempts += 1;
    throw Object.assign(new Error('temporary media file disappeared'), { code: 'ENOENT' });
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.equal(result.failed, true);
  assert.equal(result.scope, 'infrastructure');
  assert.equal(state.attempts, 1);
  assert.equal(state.failedPublication?.id, 77);
  assert.equal(state.finished, null);
});

test('publication prefetches source media only for posts that still need sending', async () => {
  const state = createHarness(3, {
    listPublicationPosts: async () => [
      { position: 1, sendState: 'sent' },
      { position: 2, sendState: 'failed', lastErrorCode: 'MEDIA_TOO_LARGE', lastError: 'too large' },
      { position: 3, sendState: 'pending' }
    ]
  });
  let preparedPosts = null;
  state.publisher.mediaDownloader.preparePublicationMediaContext = async (posts) => {
    preparedPosts = posts;
    return { source: 'scheduled-publication', sourceMessagesByChatId: new Map(), sourceMessagesComplete: true };
  };
  state.publisher.publishPost = async (post, index, onBeforeSend) => {
    assert.equal(post.messageId, 3);
    assert.equal(index, 2);
    await onBeforeSend();
    return { message_id: 103 };
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 1 });
  assert.deepEqual(preparedPosts.map((post) => post.messageId), [3]);
});

test('publication skips media prefetch when every snapshot post is already terminal', async () => {
  const state = createHarness(2, {
    listPublicationPosts: async () => [
      { position: 1, sendState: 'sent' },
      { position: 2, sendState: 'failed', lastErrorCode: 'MEDIA_TOO_LARGE', lastError: 'too large' }
    ]
  });
  let prepareCalls = 0;
  state.publisher.mediaDownloader.preparePublicationMediaContext = async () => { prepareCalls += 1; };
  state.publisher.publishPost = async () => assert.fail('no post should be sent');

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 1 });
  assert.equal(prepareCalls, 0);
});

test('created publication prepares pending source media before sending its header', async () => {
  const state = createHarness(1);
  state.request.status = 'created';
  const events = [];
  state.publisher.mediaDownloader.preparePublicationMediaContext = async () => {
    events.push('prefetch');
    return { source: 'scheduled-publication', sourceMessagesByChatId: new Map(), sourceMessagesComplete: true };
  };
  state.publisher.sendPublicationHeader = async () => {
    events.push('header');
    return { sent: true };
  };
  state.publisher.publishPost = async (_post, _index, onBeforeSend) => {
    events.push('post');
    await onBeforeSend();
    return { message_id: 101 };
  };

  const result = await state.publisher.processPublicationRequest(state.request);

  assert.deepEqual(result, { published: true, skippedPosts: 0 });
  assert.deepEqual(events, ['prefetch', 'header', 'post']);
});
