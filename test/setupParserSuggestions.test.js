import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMessagesForParser,
  buildParserSuggestions,
  buildReactionRules,
  countNativeReactionEmojis,
  detectAuthorEntities,
  filterSuggestionsByCategory,
  formatParserSuggestions,
  formatReactionCountsForDisplay,
  formatSuggestionOptions,
  getSuggestionCategory,
  getSetupValuesByPath,
  isFilterSuggestionActive,
  markSuggestionStates,
  toggleFilterSuggestion
} from '../src/telegram/setup/parserSuggestions.js';

test('parser analysis detects content, author labels, senders, button counters and native reactions', () => {
  const messages = [
    message({ id: 1, text: 'By: Alice\nFirst meme', buttons: ['👍 3', '👎 1'], nativeReactions: [{ reaction: '🔥', count: 7 }] }),
    message({ id: 2, text: 'Автор: Bob\nSecond meme', buttons: ['👍 5'], sender: { id: 42, firstName: 'Bot', username: 'source_bot' } }),
    message({ id: 3, text: '', photo: false })
  ];

  const stats = analyzeMessagesForParser(messages);

  assert.equal(stats.scanned, 3);
  assert.equal(stats.contentCount, 2);
  assert.equal(stats.mediaCount, 2);
  assert.equal(stats.authorLines.length, 4);
  assert.equal(stats.buttonPaths.get('replyMarkup.rows[].buttons[].text').length, 3);
  assert.equal(stats.nativeReactionPaths.get('nativeReactions[]').length, 1);
  assert.deepEqual(getSetupValuesByPath(messages[0], 'replyMarkup.rows[].buttons[].text'), ['👍 3', '👎 1']);
});

test('quick setup recommends exactly one reaction method based on parsed reaction volume', () => {
  const messages = Array.from({ length: 12 }, (_, index) => message({
    id: index + 1,
    text: `By: Alice\nPost ${index + 1}`,
    buttons: ['👍 1'],
    nativeReactions: [{ reaction: '🔥', count: 30 + index }]
  }));

  const suggestions = buildParserSuggestions(messages, { parsing: { filters: [], author: [], likes: [], dislikes: [] } });
  const reactionSuggestions = suggestions.filter((item) => getSuggestionCategory(item) === 'reactions');
  const recommendedReactions = reactionSuggestions.filter((item) => item.recommended);
  const recommended = recommendedReactions[0];
  const rec = suggestions.find((item) => item.id === 'rec');
  const draft = { parsing: { filters: [], author: [], likes: [], dislikes: [] } };

  assert.equal(recommendedReactions.length, 1);
  assert.match(recommended.id, /^r_native_/);
  assert.ok(reactionSuggestions.some((item) => item.id.startsWith('r_buttons')));
  assert.match(rec.description, /reactions: native/);

  rec.apply(draft);
  assert.equal(draft.parsing.likes[0].transform, 'reactionCount');
  assert.equal(draft.parsing.likes[0].path, 'nativeReactions[]');
});

test('filter suggestions can be toggled without duplicating parsing rules', () => {
  const messages = [message({ id: 1, text: 'hello' })];
  const suggestions = buildParserSuggestions(messages, { parsing: { filters: [], author: [], likes: [], dislikes: [] } });
  const filter = suggestions.find((item) => item.id === 'f_content');
  const draft = { parsing: { filters: [], author: [], likes: [], dislikes: [] } };

  assert.equal(isFilterSuggestionActive(filter, draft), false);
  assert.equal(toggleFilterSuggestion(draft, filter), 'added');
  assert.equal(toggleFilterSuggestion(draft, filter), 'removed');
  assert.deepEqual(draft.parsing.filters, []);

  toggleFilterSuggestion(draft, filter);
  toggleFilterSuggestion(draft, filter);
  toggleFilterSuggestion(draft, filter);
  assert.deepEqual(draft.parsing.filters, [{ source: 'message', transform: 'hasContent' }]);
  assert.equal(markSuggestionStates([filter], draft)[0].active, true);
});

test('suggestion formatters expose categories, current state and custom reaction labels', () => {
  const suggestions = markSuggestionStates([
    { id: 'f_content', title: 'Content filter · has content', description: 'content', filterRules: [{ source: 'message', transform: 'hasContent' }], apply: () => {} },
    { id: 'a_name', title: 'Author · sender first name', description: 'sender', apply: (draft) => { draft.parsing.author = [{ source: 'sender', path: 'firstName' }]; } },
    { id: 'r_native_conservative', title: 'native · conservative', description: 'native', apply: (draft) => { draft.parsing.likes = [{ transform: 'reactionCount' }]; } }
  ], { parsing: { filters: [{ source: 'message', transform: 'hasContent' }], author: [], likes: [] } });

  assert.deepEqual(filterSuggestionsByCategory(suggestions, 'filters').map((item) => item.id), ['f_content']);
  assert.match(formatParserSuggestions({ suggestions, scanned: 10, matched: 4 }), /Content filter · has content/);
  assert.match(formatSuggestionOptions({ title: 'Reaction options', icon: '👍', categoryTitle: 'Modes', suggestions, scanned: 10, matched: 4 }), /✓ Content filter/);
  assert.equal(formatReactionCountsForDisplay([['123456789', 3], ['custom:abc', 4], ['👍', 5], ['123456789', 2]]), '◆=9 👍=5');
  assert.deepEqual(countNativeReactionEmojis([{ reaction: '🔥', count: 2 }, { reaction: '🔥', count: 3 }, { reaction: '👍', count: 1 }]), [['🔥', 5], ['👍', 1]]);
  assert.equal(buildReactionRules('replyMarkup.rows[].buttons[].text', ['👍'])[0].aggregate, 'sum');
});

test('author entity detection handles text mentions, usernames and tg user links', () => {
  const text = 'Credit @alice and Bob';
  const result = detectAuthorEntities({
    text,
    entities: [
      { type: 'mention', offset: 7, length: 6 },
      { type: 'text_mention', offset: 18, length: 3, user: { id: 100 } },
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=200' }
    ]
  });

  assert.equal(result.username, true);
  assert.equal(result.usernameExample, '@alice');
  assert.equal(result.mentionName, true);
  assert.ok(result.mentionNameExample);
});

function message({ id, text = 'Post', buttons = [], nativeReactions = [], photo = true, sender = { id: 42, firstName: 'Source', username: 'source_bot' } } = {}) {
  return {
    id,
    date: 1717200000 + Number(id || 0),
    message: text,
    text,
    sender,
    senderId: sender.id,
    photo: photo ? { id: Number(id || 1) * 1000 } : undefined,
    nativeReactions,
    replyMarkup: buttons.length
      ? { rows: [ { buttons: buttons.map((button) => ({ text: button })) } ] }
      : undefined
  };
}
