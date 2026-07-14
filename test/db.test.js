import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostRepository } from '../src/database/postRepository.js';
import { compileReactionScore, compileSourceWhere } from '../src/core/sourceExpression.js';

test('PostRepository upserts and orders top posts', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-posts.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  await repository.upsertPost(post({ messageId: 1, likes: 10, dislikes: 1 }));
  await repository.upsertPost(post({ messageId: 2, likes: 8, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 1, likes: 20, dislikes: 1 }));
  await repository.upsertPost(post({ messageId: 3, likes: 10, dislikes: 9 }));
  await repository.upsertPost(post({ messageId: 4, likes: 10, dislikes: 100 }));

  const rows = await repository.getTopPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    limit: 2
  });

  assert.deepEqual(rows.map((row) => row.messageId), [1, 2]);
  assert.equal(rows[0].likes, 20);
  assert.equal(rows[0].author, 'Alice');

  const controversial = await repository.getControversialPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    limit: 2,
    threshold: 0.3
  });

  assert.deepEqual(controversial.map((row) => row.messageId), [4, 1]);

  const publicationId = await repository.createPublication({
    selectionKey: 'best.week',
    title: 'Best posts from the last week',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
    status: 'published',
    posts: rows
  });
  const publications = await repository.all('SELECT selection_key AS selectionKey, status FROM publications WHERE id = ?', [publicationId]);
  const publicationPosts = await repository.all('SELECT COUNT(*) AS count FROM publication_posts WHERE publication_id = ?', [publicationId]);

  assert.deepEqual(publications[0], { selectionKey: 'best.week', status: 'published' });
  assert.equal(publicationPosts[0].count, 2);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository publication requests are durable and block duplicates until failure', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-publications.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const first = await repository.tryCreatePublicationRequest(publicationClaim());
  const duplicate = await repository.tryCreatePublicationRequest(publicationClaim());

  assert.equal(typeof first, 'number');
  assert.equal(duplicate, null);

  await repository.failPublication(first, new Error('network failed'));
  const retry = await repository.tryCreatePublicationRequest(publicationClaim());

  assert.equal(typeof retry, 'number');
  assert.notEqual(retry, first);

  await repository.finishPublication(retry, {
    status: 'published',
    posts: [post({ messageId: 10, likes: 5, dislikes: 1 })],
    data: { count: 1 }
  });
  const afterPublished = await repository.tryCreatePublicationRequest(publicationClaim());
  const rows = await repository.all('SELECT status FROM publications WHERE key = ? ORDER BY id', ['publish:best.week:2026-W27']);

  assert.equal(afterPublished, null);
  assert.deepEqual(rows.map((row) => row.status), ['failed', 'published']);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository atomically leases publication requests across processes', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-leases.sqlite`);
  await fs.rm(dbPath, { force: true });
  const firstRepository = new PostRepository(dbPath);
  const secondRepository = new PostRepository(dbPath);
  await Promise.all([firstRepository.init(), secondRepository.init()]);
  try {
    const publicationId = await firstRepository.tryCreatePublicationRequest(publicationClaim());
    const first = await firstRepository.getNextPublicationRequest({ ownerId: 'worker-1', leaseMs: 60_000 });
    await firstRepository.run(
      'UPDATE publications SET created_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', publicationId]
    );
    const blocked = await secondRepository.getNextPublicationRequest({ ownerId: 'worker-2', leaseMs: 60_000 });
    assert.equal(first.id, publicationId);
    assert.equal(blocked, null);

    await firstRepository.run(
      'UPDATE publications SET lease_until = ?, created_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', new Date().toISOString(), publicationId]
    );
    const reclaimed = await secondRepository.getNextPublicationRequest({ ownerId: 'worker-2', leaseMs: 60_000 });
    assert.equal(reclaimed.id, publicationId);
    assert.equal(reclaimed.leaseOwner, 'worker-2');
  } finally {
    await firstRepository.close();
    await secondRepository.close();
    await fs.rm(dbPath, { force: true });
  }
});

test('PostRepository preserves an interrupted send as uncertain and blocks automatic duplication', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-uncertain.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();
  try {
    const publicationId = await repository.tryCreatePublicationRequest(publicationClaim());
    await repository.getNextPublicationRequest({ ownerId: 'worker-1', leaseMs: 60_000 });
    await repository.markPublicationRunning(publicationId, 'worker-1');
    await repository.markPublicationPostSending({
      publicationId,
      post: post({ messageId: 10 }),
      position: 1
    });
    await repository.markPublicationUncertain(publicationId, 'worker-1', new Error('process interrupted'));

    const row = await repository.getPublicationById(publicationId);
    const next = await repository.getNextPublicationRequest({ ownerId: 'worker-2' });
    const duplicate = await repository.tryCreatePublicationRequest(publicationClaim());
    const posts = await repository.listPublicationPosts(publicationId);
    assert.equal(row.status, 'uncertain');
    assert.equal(next, null);
    assert.equal(duplicate, null);
    assert.equal(posts[0].sendState, 'sending');
  } finally {
    await repository.close();
    await fs.rm(dbPath, { force: true });
  }
});

test('PostRepository dry-run publications do not block later real publication', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-dryrun.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const dryRun = await repository.tryCreatePublicationRequest(publicationClaim());
  await repository.finishPublication(dryRun, {
    status: 'dry_run',
    posts: [],
    data: { count: 0 }
  });

  const real = await repository.tryCreatePublicationRequest(publicationClaim());

  assert.equal(typeof real, 'number');
  assert.notEqual(real, dryRun);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository blocking publication lookup ignores newer non-blocking rows', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-blocking-publication.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const active = await repository.tryCreatePublicationRequest(publicationClaim());
  await repository.failPublication(active, new Error('temporary failure'));
  const published = await repository.tryCreatePublicationRequest(publicationClaim());
  await repository.finishPublication(published, {
    status: 'published',
    posts: [],
    data: { count: 0 }
  });
  const failed = await repository.tryCreatePublicationRequest({
    ...publicationClaim(),
    key: 'publish:best.week:2026-W27-force'
  });
  await repository.failPublication(failed, new Error('newer failed row'));
  await repository.run(
    'UPDATE publications SET key = ?, updated_at = ? WHERE id = ?',
    ['publish:best.week:2026-W27', '2026-06-29T12:00:00.000Z', failed]
  );

  const latest = await repository.getPublicationByKey('publish:best.week:2026-W27');
  const blocking = await repository.getBlockingPublicationByKey('publish:best.week:2026-W27');

  assert.equal(latest.id, failed);
  assert.equal(latest.status, 'failed');
  assert.equal(blocking.id, published);
  assert.equal(blocking.status, 'published');

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository finishPublication preserves sent post metadata', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-sent-posts.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const publicationId = await repository.tryCreatePublicationRequest(publicationClaim());
  const selectedPost = post({ messageId: 10, likes: 5, dislikes: 1 });

  await repository.recordPublicationPost({
    publicationId,
    post: selectedPost,
    position: 1,
    botMessageId: 12345
  });
  await repository.finishPublication(publicationId, {
    status: 'published',
    posts: [selectedPost],
    data: { count: 1 }
  });

  const rows = await repository.listPublicationPosts(publicationId);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].botMessageId, 12345);
  assert.equal(typeof rows[0].sentAt, 'string');

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository listPublicationJobs returns active and latest finished jobs by updated_at', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-jobs.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const firstActive = await repository.tryCreatePublicationRequest({
    ...publicationClaim(),
    key: 'publish:best.day:2026-06-28',
    selectionKey: 'best.day'
  });
  const secondActive = await repository.tryCreatePublicationRequest({
    ...publicationClaim(),
    key: 'publish:best.week:2026-W27',
    selectionKey: 'best.week'
  });
  const failed = await repository.tryCreatePublicationRequest({
    ...publicationClaim(),
    key: 'publish:best.month:2026-06',
    selectionKey: 'best.month'
  });
  await repository.failPublication(failed, new Error('network failed'));

  await repository.run('UPDATE publications SET updated_at = ? WHERE id = ?', ['2026-06-29T10:00:00.000Z', firstActive]);
  await repository.run('UPDATE publications SET updated_at = ? WHERE id = ?', ['2026-06-29T12:00:00.000Z', secondActive]);
  await repository.run('UPDATE publications SET updated_at = ? WHERE id = ?', ['2026-06-29T11:00:00.000Z', failed]);

  const jobs = await repository.listPublicationJobs({ finishedLimit: 5 });

  assert.deepEqual(jobs.active.map((job) => job.id), [secondActive, firstActive]);
  assert.deepEqual(jobs.finished.map((job) => job.id), [failed]);
  assert.equal(jobs.finished[0].lastError, 'network failed');

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository lists recent publications and detailed posts', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-publication-list.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const firstPost = {
    chatId: -1002,
    messageId: 100,
    author: 'Alice',
    text: 'First',
    likes: 10,
    dislikes: 1,
    data: {},
    messageDate: '2026-06-29T10:00:00.000Z'
  };
  await repository.upsertPost(firstPost);

  const older = await repository.createPublication({
    selectionKey: 'best.day',
    title: 'Best day',
    periodStart: '2026-06-28T00:00:00.000Z',
    periodEnd: '2026-06-29T00:00:00.000Z',
    status: 'published',
    posts: [firstPost],
    data: { count: 1 }
  });
  const newer = await repository.tryCreatePublicationRequest({
    ...publicationClaim(),
    key: 'publish:best.week:2026-W27',
    selectionKey: 'best.week',
    data: { count: 3 }
  });

  await repository.run('UPDATE publications SET updated_at = ? WHERE id = ?', ['2026-06-29T10:00:00.000Z', older]);
  await repository.run('UPDATE publications SET updated_at = ? WHERE id = ?', ['2026-06-29T12:00:00.000Z', newer]);

  const publications = await repository.listRecentPublications({ limit: 10 });
  assert.deepEqual(publications.map((row) => row.id), [newer, older]);
  assert.equal(publications[0].expectedCount, 3);
  assert.equal(publications[1].sentCount, 1);

  const publication = await repository.getPublicationById(older);
  assert.equal(publication.title, 'Best day');

  const posts = await repository.listPublicationPostsDetailed(older);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].messageId, 100);
  assert.equal(posts[0].author, 'Alice');

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository deletes posts older than retention cutoff without deleting publication history', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-retention.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  const oldPost = postRow(1, '2026-04-01T00:00:00.000Z');
  const freshPost = postRow(2, '2026-06-01T00:00:00.000Z');
  await repository.upsertPost(oldPost);
  await repository.upsertPost(freshPost);
  const publicationId = await repository.createPublication({
    selectionKey: 'best.month',
    title: 'Best month',
    periodStart: '2026-04-01T00:00:00.000Z',
    periodEnd: '2026-05-01T00:00:00.000Z',
    status: 'published',
    posts: [oldPost],
    data: { count: 1 }
  });

  const deleted = await repository.deletePostsOlderThan(-1002, '2026-05-01T00:00:00.000Z');
  const posts = await repository.all('SELECT message_id AS messageId FROM posts ORDER BY message_id');
  const publicationPosts = await repository.listPublicationPosts(publicationId);

  assert.equal(deleted, 1);
  assert.deepEqual(posts, [{ messageId: 2 }]);
  assert.equal(publicationPosts.length, 1);
  assert.equal(publicationPosts[0].messageId, 1);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository selection windows are half-open at the boundary', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-boundary.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  await repository.upsertPost(post({ messageId: 1, likes: 10, dislikes: 0, messageDate: '2026-06-29T09:59:59.999Z' }));
  await repository.upsertPost(post({ messageId: 2, likes: 20, dislikes: 0, messageDate: '2026-06-29T10:00:00.000Z' }));
  await repository.upsertPost(post({ messageId: 3, likes: 30, dislikes: 0, messageDate: '2026-06-30T10:00:00.000Z' }));

  const previous = await repository.getTopPosts({
    chatId: -1001,
    sinceIso: '2026-06-28T10:00:00.000Z',
    untilIso: '2026-06-29T10:00:00.000Z',
    limit: 10
  });
  const next = await repository.getTopPosts({
    chatId: -1001,
    sinceIso: '2026-06-29T10:00:00.000Z',
    untilIso: '2026-06-30T10:00:00.000Z',
    limit: 10
  });

  assert.deepEqual(previous.map((row) => row.messageId), [1]);
  assert.deepEqual(next.map((row) => row.messageId), [2]);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

test('PostRepository applies custom source expressions and reaction selection in SQL', async () => {
  const dbPath = path.join(os.tmpdir(), `tg-memes-${process.pid}-${Date.now()}-selection-sql.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  await repository.upsertPost(post({ messageId: 1, likes: 100, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 2, likes: 50, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 3, likes: 20, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 4, likes: 5, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 5, likes: 1, dislikes: 0 }));

  const filtered = await repository.getSelectionPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    sourceWhereSql: compileSourceWhere('likes >= 5 and dislikes = 0'),
    reactionScoreSql: compileReactionScore('likes'),
    posts: { min: 1, target: 2, max: 4 },
    reactions: { min: 10, includeAbove: 15 }
  });
  const backfilled = await repository.getSelectionPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    sourceWhereSql: compileSourceWhere('true'),
    reactionScoreSql: compileReactionScore('likes'),
    posts: { min: 4, target: 2, max: 5 },
    reactions: { min: 10, includeAbove: 999 }
  });
  const capped = await repository.getSelectionPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    sourceWhereSql: compileSourceWhere('true'),
    reactionScoreSql: compileReactionScore('likes'),
    posts: { min: 1, target: 2, max: 2 },
    reactions: { min: 0, includeAbove: 1 }
  });

  assert.deepEqual(filtered.map((row) => row.messageId), [1, 2, 3]);
  assert.deepEqual(backfilled.map((row) => row.messageId), [1, 2, 3, 4]);
  assert.deepEqual(capped.map((row) => row.messageId), [1, 2]);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

function publicationClaim() {
  return {
    key: 'publish:best.week:2026-W27',
    selectionKey: 'best.week',
    title: 'Best week',
    periodStart: '2026-06-22T00:00:00.000Z',
    periodEnd: '2026-06-29T00:00:00.000Z',
    data: { count: 1 }
  };
}

function postRow(messageId, messageDate) {
  return {
    chatId: -1002,
    messageId,
    author: 'Alice',
    text: 'Post',
    likes: 10,
    dislikes: 1,
    data: {},
    messageDate
  };
}

function post(overrides) {
  return {
    chatId: -1001,
    messageId: overrides.messageId,
    author: 'Alice',
    text: 'By Alice',
    likes: overrides.likes,
    dislikes: overrides.dislikes,
    messageDate: overrides.messageDate || '2026-06-15T00:00:00.000Z',
    data: { media: [] }
  };
}
