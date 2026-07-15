import assert from 'node:assert/strict';
import test from 'node:test';
import { compileReactionScore, compileSourceWhere } from '../src/core/sourceExpression.js';

test('source expression parser compiles valid boolean and arithmetic expressions', () => {
  assert.equal(
    compileSourceWhere('likes >= 10 and dislikes < max(likes, 2) * 0.5'),
    '((likes >= 10) AND (dislikes < (max(likes, 2) * 0.5)))'
  );
  assert.equal(compileSourceWhere('abs(likes - dislikes)'), 'abs((likes - dislikes))');
  assert.equal(compileReactionScore('sum'), '(likes + dislikes)');
});

test('source expression parser rejects incomplete or ambiguous syntax', () => {
  for (const expression of ['likes +', 'max()', 'likes likes', 'abs(likes, dislikes)', 'likes >', 'and likes', '(likes + 1']) {
    assert.throws(() => compileSourceWhere(expression), /invalid|expected|unexpected|expects|unsupported/i);
  }
});

test('source expression parser rejects identifiers and functions outside the allowlist', () => {
  assert.throws(() => compileSourceWhere('random() > 0'), /unsupported function/i);
  assert.throws(() => compileSourceWhere('secret_column = 1'), /unsupported identifier/i);
});
