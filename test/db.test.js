import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PostRepository } from '../src/database/postRepository.js';

test('PostRepository upserts and orders top posts', async () => {
  const dbPath = path.join('/private/tmp', `tg-memes-${process.pid}.sqlite`);
  await fs.rm(dbPath, { force: true });
  const repository = new PostRepository(dbPath);
  await repository.init();

  await repository.upsertPost(post({ messageId: 1, likes: 10, dislikes: 1 }));
  await repository.upsertPost(post({ messageId: 2, likes: 8, dislikes: 0 }));
  await repository.upsertPost(post({ messageId: 1, likes: 20, dislikes: 1 }));

  const rows = await repository.getTopPosts({
    chatId: -1001,
    sinceIso: '2026-06-01T00:00:00.000Z',
    untilIso: '2026-07-01T00:00:00.000Z',
    limit: 2
  });

  assert.deepEqual(rows.map((row) => row.messageId), [1, 2]);
  assert.equal(rows[0].likes, 20);
  assert.equal(rows[0].author, 'Alice');

  const publicationId = await repository.createPublication({
    selectionKey: 'week',
    title: 'Best posts from the last week',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
    status: 'published',
    posts: rows
  });
  const publications = await repository.all('SELECT selection_key AS selectionKey, status FROM publications WHERE id = ?', [publicationId]);
  const publicationPosts = await repository.all('SELECT COUNT(*) AS count FROM publication_posts WHERE publication_id = ?', [publicationId]);

  assert.deepEqual(publications[0], { selectionKey: 'week', status: 'published' });
  assert.equal(publicationPosts[0].count, 2);

  await repository.close();
  await fs.rm(dbPath, { force: true });
});

function post(overrides) {
  return {
    chatId: -1001,
    messageId: overrides.messageId,
    author: 'Alice',
    text: 'By Alice',
    likes: overrides.likes,
    dislikes: overrides.dislikes,
    messageDate: '2026-06-15T00:00:00.000Z',
    data: { images: [] }
  };
}
