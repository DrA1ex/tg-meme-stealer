import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostRepository } from '../src/database/postRepository.js';

test('PostRepository.upsertPosts executes one synchronous transaction for the page', async () => {
  const calls = [];
  let transactions = 0;
  const repository = new PostRepository(path.join(os.tmpdir(), 'tg-memes-batch-unit.sqlite'));
  repository.db = {
    transaction(operation) {
      transactions += 1;
      return operation(this);
    },
    run(sql, params) {
      calls.push({ sql, params });
      return { changes: 1 };
    }
  };

  const written = await repository.upsertPosts([
    post(1, 10),
    post(2, 20),
    post(3, 30)
  ]);

  assert.equal(written, 3);
  assert.equal(transactions, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.params[1]), [1, 2, 3]);
  assert.ok(calls.every((call) => /INSERT INTO posts/.test(call.sql)));
});

test('PostRepository.deletePosts deduplicates ids and uses bounded SQL batches', async () => {
  const calls = [];
  let transactions = 0;
  const repository = new PostRepository(path.join(os.tmpdir(), 'tg-memes-delete-batch-unit.sqlite'));
  repository.db = {
    transaction(operation) {
      transactions += 1;
      return operation(this);
    },
    run(sql, params) {
      calls.push({ sql, params });
      return { changes: params.length - 1 };
    }
  };

  const ids = [...Array.from({ length: 505 }, (_, index) => index + 1), 1, 2, Number.NaN];
  const deleted = await repository.deletePosts(-1001, ids);

  assert.equal(transactions, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.length, 501);
  assert.equal(calls[1].params.length, 6);
  assert.equal(deleted, 505);
});

function post(messageId, likes) {
  return {
    chatId: -1001,
    messageId,
    author: 'Author',
    text: `Post ${messageId}`,
    likes,
    dislikes: 0,
    data: {},
    messageDate: '2026-07-01T00:00:00.000Z'
  };
}
