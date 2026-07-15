import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryPageAssembler } from '../src/telegram/historyAssembler.js';

test('HistoryPageAssembler carries a trailing album into the next page', () => {
  const assembler = new HistoryPageAssembler();
  assert.deepEqual(assembler.push([
    { id: 5 },
    { id: 4, groupedId: 'album' }
  ], { hasNext: true }), [{ id: 5 }]);

  assert.deepEqual(assembler.push([
    { id: 3, groupedId: 'album' },
    { id: 2 }
  ], { hasNext: false }), [
    { id: 4, groupedId: 'album' },
    { id: 3, groupedId: 'album' },
    { id: 2 }
  ]);
  assert.deepEqual(assembler.flush(), []);
});

test('HistoryPageAssembler flushes an album when history ends', () => {
  const assembler = new HistoryPageAssembler();
  assert.deepEqual(assembler.push([{ id: 2, grouped_id: 7 }], { hasNext: true }), []);
  assert.deepEqual(assembler.flush(), [{ id: 2, grouped_id: 7 }]);
});
