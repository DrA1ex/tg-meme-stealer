import {
  summarizeParsedPosts,
  DEFAULT_PREVIEW_MESSAGES,
  DEFAULT_PREVIEW_POSTS,
  formatConfirmResetFilters,
  formatParserMenu,
  formatFiltersMenu,
  formatAuthorMenu,
  formatReactionsMenu,
  formatSetupDoctor,
  buildParserSuggestions,
  formatAppliedSuggestion,
  formatNoopSuggestion,
  formatParserChanges,
  formatParserSuggestions,
  formatSuggestionOptions,
  filterSuggestionsByCategory,
  formatFiltersReset,
  confirmResetFiltersKeyboard,
  isSuggestionUseful,
  markSuggestionStates,
  toggleFilterSuggestion,
  parserSuggestionsKeyboard,
  suggestionOptionsKeyboard,
  formatAuthorExtractionTest,
  formatFilterImpact,
  formatParserPaths,
  formatReactionExtractionTest,
  button,
  authorMenuKeyboard,
  filtersMenuKeyboard,
  reactionsMenuKeyboard,
  technicalDiagnosticsKeyboard,
  parserMenuKeyboard,
  setupMenuKeyboard,
  replyCode
} from './deps.js';
import {
  getCategoryExtraRows
} from './helpers.js';

export async function parserMenu(ctx) {
  this.rememberCurrentView(ctx, 'parser');
  await this.replyWithKeyboard(ctx, formatParserMenu(this.getDraft(ctx)), parserMenuKeyboard());
}

export async function filtersMenu(ctx) {
  this.rememberCurrentView(ctx, 'filters');
  await this.replyWithKeyboard(ctx, formatFiltersMenu(this.getDraft(ctx)), filtersMenuKeyboard());
}

export async function authorMenu(ctx) {
  this.rememberCurrentView(ctx, 'author');
  await this.replyWithKeyboard(ctx, formatAuthorMenu(this.getDraft(ctx)), authorMenuKeyboard());
}

export async function reactionsMenu(ctx) {
  this.rememberCurrentView(ctx, 'reactions');
  await this.replyWithKeyboard(ctx, formatReactionsMenu(this.getDraft(ctx)), reactionsMenuKeyboard());
}

export async function doctor(ctx) {
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'setup doctor', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatSetupDoctor({ draft, baseConfig: this.config, preview: result }), setupMenuKeyboard());
}

export async function testDefaults(ctx) {
  const result = await this.collectSetupSample(ctx, { purpose: 'parser test' });
  await replyCode(ctx, summarizeParsedPosts(result, { maxRows: 12 }));
  this.markTested(ctx);
  await this.replyWithKeyboard(ctx, 'Content test finished.', parserMenuKeyboard());
}

export async function previewDefaults(ctx) {
  await this.sendPreview(ctx, {
    postCount: DEFAULT_PREVIEW_POSTS,
    messageCount: DEFAULT_PREVIEW_MESSAGES
  });
}

export async function suggestParser(ctx) {
  this.rememberCurrentView(ctx, 'suggest');
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'parser suggestions', includeMessages: true });
  const suggestions = buildParserSuggestions(result.messages || [], draft);
  this.setupSuggestions.set(ctx.from.id, suggestions);
  await this.replyWithKeyboard(
    ctx,
    formatParserSuggestions({
      suggestions: markSuggestionStates(suggestions, draft),
      scanned: result.scanned,
      matched: result.posts.length
    }),
    parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
  );
}

export async function filterOptions(ctx) {
  this.rememberCurrentView(ctx, 'filters_options');
  await this.suggestionOptions(ctx, 'filters', {
    purpose: 'filter options',
    title: 'Filter options',
    icon: '🔎',
    categoryTitle: '✨ Filter options',
    back: 'setup:filters',
    next: 'Choose filters, then run Filter impact or Test content.'
  });
}

export async function authorOptions(ctx) {
  this.rememberCurrentView(ctx, 'author_options');
  await this.suggestionOptions(ctx, 'author', {
    purpose: 'author options',
    title: 'Author options',
    icon: '👤',
    categoryTitle: '✨ Author options',
    back: 'setup:author',
    next: 'Choose one author mode, then run Test author.'
  });
}

export async function reactionOptions(ctx) {
  this.rememberCurrentView(ctx, 'reaction_options');
  await this.suggestionOptions(ctx, 'reactions', {
    purpose: 'reaction options',
    title: 'Reaction options',
    icon: '👍',
    categoryTitle: '✨ Reaction options',
    back: 'setup:reactions',
    next: 'Choose one reaction mode, then run Test reactions.'
  });
}

export async function suggestionOptions(ctx, category, options) {
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: options.purpose, includeMessages: true });
  const suggestions = buildParserSuggestions(result.messages || [], draft);
  this.setupSuggestions.set(ctx.from.id, suggestions);
  const states = markSuggestionStates(filterSuggestionsByCategory(suggestions, category), draft);
  await this.replaceCurrentSetupMessage(
    ctx,
    formatSuggestionOptions({
      title: options.title,
      icon: options.icon,
      categoryTitle: options.categoryTitle,
      suggestions: states,
      scanned: result.scanned,
      matched: result.posts.length,
      next: options.next
    }),
    suggestionOptionsKeyboard(states, { back: options.back, extraRows: getCategoryExtraRows(category), loadMoreTarget: options.loadMoreTarget || `${category}_options` })
  );
}

export async function parserPaths(ctx) {
  this.rememberCurrentView(ctx, 'parser_paths');
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'parser paths', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatParserPaths(result.messages || [], draft), technicalDiagnosticsKeyboard());
}

export async function authorTest(ctx) {
  this.rememberCurrentView(ctx, 'author_test');
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'author extraction test', includeMessages: true });
  this.markTested(ctx);
  await this.replyWithKeyboard(ctx, formatAuthorExtractionTest({
    messages: result.messages || [],
    draft,
    baseConfig: this.config
  }), authorMenuKeyboard());
}

export async function reactionTest(ctx) {
  this.rememberCurrentView(ctx, 'reaction_test');
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'reaction extraction test', includeMessages: true });
  this.markTested(ctx);
  await this.replyWithKeyboard(ctx, formatReactionExtractionTest({
    messages: result.messages || [],
    draft,
    baseConfig: this.config
  }), reactionsMenuKeyboard());
}

export async function filterImpact(ctx) {
  this.rememberCurrentView(ctx, 'filter_impact');
  const draft = this.getDraft(ctx);
  const result = await this.collectSetupSample(ctx, { purpose: 'filter impact', includeMessages: true });
  await this.replyWithKeyboard(ctx, formatFilterImpact({
    messages: result.messages || [],
    draft,
    baseConfig: this.config
  }), suggestionOptionsKeyboard(markSuggestionStates(filterSuggestionsByCategory(buildParserSuggestions(result.messages || [], draft), 'filters'), draft), { back: 'setup:filters', extraRows: getCategoryExtraRows('filters'), loadMoreTarget: 'filter_impact' }));
}

export async function applySuggestion(ctx, suggestionId) {
  const suggestions = this.setupSuggestions.get(ctx.from.id) || [];
  const suggestion = suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) {
    await this.replyWithKeyboard(
      ctx,
      'This suggestion is no longer available. Run Auto suggestions again.',
      parserMenuKeyboard()
    );
    return;
  }

  const draft = this.getDraft(ctx);
  if (!isSuggestionUseful(suggestion, draft)) {
    await this.replyWithKeyboard(
      ctx,
      formatNoopSuggestion(suggestion),
      parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
    );
    return;
  }

  const beforeParsing = structuredClone(draft.parsing || {});
  const filterToggleAction = suggestion.filterRules?.length ? toggleFilterSuggestion(draft, suggestion) : null;
  if (!filterToggleAction) suggestion.apply(draft);
  const afterParsing = structuredClone(draft.parsing || {});
  const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
  this.markChanged(ctx, 'parser', `${filterToggleAction === 'removed' ? 'Removed filter suggestion' : 'Applied parser suggestion'}: ${suggestion.title}`, detail);
  if (filterToggleAction) {
    await this.filterOptions(ctx);
    return;
  }
  await this.replyWithKeyboard(
    ctx,
    [
      formatAppliedSuggestion({
        suggestion,
        beforeParsing,
        afterParsing
      }),
      '',
      'You can apply another suggestion from the same list, or run Test content / Preview.'
    ].join('\n'),
    parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
  );
}

export async function confirmResetFilters(ctx) {
  const filters = this.getDraft(ctx).parsing?.filters || [];
  await this.replyWithKeyboard(ctx, formatConfirmResetFilters(filters), confirmResetFiltersKeyboard());
}

export async function resetFilters(ctx) {
  const draft = this.getDraft(ctx);
  const beforeParsing = structuredClone(draft.parsing || {});
  draft.parsing.filters = [];
  const afterParsing = structuredClone(draft.parsing || {});
  const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
  this.markChanged(ctx, 'parser', 'Reset parser filters', detail);
  const suggestions = this.setupSuggestions.get(ctx.from.id) || [];
  const keyboard = suggestions.length
                   ? parserSuggestionsKeyboard(markSuggestionStates(suggestions, draft))
                   : parserMenuKeyboard();
  await this.replyWithKeyboard(
    ctx,
    formatFiltersReset({ beforeParsing, afterParsing, hasSuggestions: suggestions.length > 0 }),
    keyboard
  );
}

export async function resetAuthor(ctx) {
  const draft = this.getDraft(ctx);
  const beforeParsing = structuredClone(draft.parsing || {});
  draft.parsing.author = [];
  const afterParsing = structuredClone(draft.parsing || {});
  const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
  this.markChanged(ctx, 'parser', 'Reset author extraction', detail);
  await this.replyWithKeyboard(ctx, [
    '✅ Author rules reset.',
    '',
    'Open Author options to choose a new author extraction mode.'
  ].join('\n'), authorMenuKeyboard());
}

export async function resetReactions(ctx) {
  const draft = this.getDraft(ctx);
  const beforeParsing = structuredClone(draft.parsing || {});
  draft.parsing.likes = [];
  draft.parsing.dislikes = [];
  const afterParsing = structuredClone(draft.parsing || {});
  const detail = formatParserChanges(beforeParsing, afterParsing, { compact: false });
  this.markChanged(ctx, 'parser', 'Reset reaction parsing', detail);
  await this.replyWithKeyboard(ctx, [
    '✅ Reaction rules reset.',
    '',
    'Open Reaction options to choose button counters or native reactions.'
  ].join('\n'), reactionsMenuKeyboard());
}

export const parserFlowMethods = {
  parserMenu,
  filtersMenu,
  authorMenu,
  reactionsMenu,
  doctor,
  testDefaults,
  previewDefaults,
  suggestParser,
  filterOptions,
  authorOptions,
  reactionOptions,
  suggestionOptions,
  parserPaths,
  authorTest,
  reactionTest,
  filterImpact,
  applySuggestion,
  confirmResetFilters,
  resetFilters,
  resetAuthor,
  resetReactions
};
