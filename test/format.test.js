import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPostCaption, renderTemplate } from '../src/core/format.js';

test('renderTemplate replaces named placeholders', () => {
  assert.equal(renderTemplate('Hello {{ name }} #{{id}}', { name: 'Alice', id: 7 }), 'Hello Alice #7');
});

test('formatPostCaption uses configured publish template', () => {
  const caption = formatPostCaption(
    {
      chatId: -1001,
      messageId: 10,
      author: 'Alice',
      text: 'Long text',
      likes: 12,
      dislikes: 3
    },
    1,
    {
      publish: {
        postCaption: '#{{position}} {{author}} score={{score}} media={{mediaSummary}} text={{text}}',
        maxTextLength: 100
      }
    }
  );

  assert.equal(caption, '#2 Alice score=9 media=none text=Long text');
});
