import {
  button,
  parseMessagesToPosts
} from './deps.js';

export function clampIndex(index = 0, total = 0) {
  if (!total) return 0;
  const parsed = Number(index || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, parsed), total - 1);
}

export function normalizeLoadMoreTarget(target, fallback = 'suggest') {
  const allowed = new Set([
    'suggest',
    'filters_options',
    'author_options',
    'reaction_options',
    'filter_impact',
    'author_test',
    'reaction_test',
    'parser_paths',
    'technical',
    'technical_field_scan',
    'technical_shape',
    'technical_reactions',
    'technical_author',
    'sources',
    'manual_schedule',
    'test'
  ]);
  const normalized = String(target || '').trim();
  if (allowed.has(normalized) || normalized.startsWith('technical_trace:') || normalized.startsWith('technical_raw:') || normalized.startsWith('technical_preview') || normalized.startsWith('technical_msg:')) return normalized;
  const fallbackValue = String(fallback || '').trim();
  if (allowed.has(fallbackValue) || fallbackValue.startsWith('technical_trace:') || fallbackValue.startsWith('technical_raw:') || fallbackValue.startsWith('technical_preview') || fallbackValue.startsWith('technical_msg:')) return fallbackValue;
  return 'suggest';
}

export function normalizeTechnicalTraceMode(mode) {
  const normalized = String(mode || 'matched').trim();
  return ['matched', 'rejected', 'unknown_author', 'zero_likes'].includes(normalized) ? normalized : 'matched';
}

export function normalizeTechnicalRawMode(mode) {
  const normalized = String(mode || 'matched').trim();
  return ['matched', 'rejected', 'buttons', 'native_reactions', 'mention'].includes(normalized) ? normalized : 'matched';
}

export function formatLoadMoreTarget(target) {
  return String(target || 'suggest').replace(/_/g, ' ');
}

export function getCategoryExtraRows(category) {
  if (category === 'filters') return [[button('Pending Config', 'setup:filters_pending_config')], [button('Filter impact', 'setup:filter_impact'), button('Test content', 'setup:test')]];
  if (category === 'author') return [[button('Pending Config', 'setup:author_pending_config')], [button('Test author', 'setup:author_test')]];
  if (category === 'reactions') return [[button('Pending Config', 'setup:reactions_pending_config')], [button('Test reactions', 'setup:reaction_test'), button('Reaction diagnostics', 'setup:technical_reactions')]];
  return [];
}

export function formatPreviewProgress({ total, sent, current = null }) {
  const lines = [
    '📤 Sending preview',
    '',
    `The bot will send ${total} preview post(s).`,
    `Sent: ${sent}/${total}.`
  ];
  if (current !== null) lines.push('', `Sending post ${current}/${total}...`);
  return lines.join('\n');
}

export function parseCachedSetupPosts(messages, draft, config) {
  return parseMessagesToPosts(messages, {
    chatId: config.telegram?.sourceChatId,
    parsing: draft.parsing || config.parsing || {}
  });
}

export function formatSampleProgress({ purpose, scanned, matched, minMatched, maxLimit, exhausted = false, status = 'loading' }) {
  const hasMatchedTarget = Number.isFinite(Number(minMatched));
  const lines = [
    `🔎 Collecting sample · ${purpose}`,
    '',
    `Loaded: ${scanned}/${maxLimit} message(s).`,
    hasMatchedTarget
    ? `Matched parser filters: ${matched}/${minMatched}.`
    : `Matched parser filters: ${matched}.`
  ];
  if (status === 'starting') lines.push('', 'Starting scan...');
  else if (status === 'using-cache') lines.push('', 'Using cached messages first. Loading more only if needed...');
  else if (status === 'done') {
    if (!hasMatchedTarget) lines.push('', exhausted ? 'Done. Source history ended.' : 'Done. Loaded one more sample page.');
    else if (matched >= minMatched) lines.push('', 'Done. Enough matched posts for a reliable sample.');
    else if (exhausted) lines.push('', 'Done. Source history ended before enough matched posts were found.');
    else lines.push('', 'Done. Sample is still small; parser filters may be strict.');
  } else if (!hasMatchedTarget || matched < minMatched) {
    lines.push('', 'Loading more messages...');
  }
  return lines.join('\n');
}
