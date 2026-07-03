const DEFAULT_LIKE_MARKERS = ['👍', '❤', '❤️', '🔥', '+'];
const DEFAULT_DISLIKE_MARKERS = ['👎', '-'];

export function parseCount(value) {
  return parseCountDetails(value).result;
}

export function parseCountDetails(value) {
  if (!value) {
    return { input: value, normalized: '', matched: false, result: 0 };
  }
  const normalized = String(value).replace(',', '.').replace(/\s+/g, '');
  const match = normalized.match(/(\d+(?:\.\d+)?)([k\u043am\u043c])?/i);
  if (!match) {
    return { input: value, normalized, matched: false, result: 0 };
  }

  const number = Number.parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'k' || suffix === '\u043a'
    ? 1000
    : suffix === 'm' || suffix === '\u043c'
      ? 1000000
      : 1;
  return {
    input: value,
    normalized,
    matched: true,
    number,
    suffix: suffix || '',
    multiplier,
    result: Math.round(number * multiplier)
  };
}

export function parseReactions(replyMarkup) {
  const result = { likes: 0, dislikes: 0 };
  const rows = replyMarkup?.rows || replyMarkup?.buttons || [];

  for (const row of rows) {
    for (const button of row.buttons || row || []) {
      const text = button.text || '';
      if (DEFAULT_LIKE_MARKERS.some((marker) => text.includes(marker))) {
        result.likes += parseCount(text);
      } else if (DEFAULT_DISLIKE_MARKERS.some((marker) => text.includes(marker))) {
        result.dislikes += parseCount(text);
      }
    }
  }

  return result;
}


export function getReactionEmoji(value) {
  const reaction = value?.reaction ?? value?.type ?? value;
  if (typeof reaction === 'string') return reaction;
  return String(
    reaction?.emoji ??
      reaction?.emoticon ??
      reaction?.value ??
      reaction?.reaction ??
      reaction?.customEmojiId ??
      reaction?.custom_emoji_id ??
      reaction?.documentId ??
      reaction?.document_id ??
      value?.customEmojiId ??
      value?.custom_emoji_id ??
      value?.documentId ??
      value?.document_id ??
      ''
  );
}

export function getReactionCount(value) {
  const raw = value?.count ?? value?.total_count ?? value?.totalCount ?? value?.total ?? 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseReactionCount(value, rule = {}) {
  const emoji = getReactionEmoji(value);
  const count = getReactionCount(value);
  const emojis = getRuleEmojis(rule);
  const listed = emojis.includes(emoji);
  const matched = Boolean(emoji) && (emojis.length === 0 ? true : (rule.invert ? !listed : listed));
  return matched ? count : 0;
}

export function parseReactionCountDetails(value, rule = {}) {
  const emoji = getReactionEmoji(value);
  const count = getReactionCount(value);
  const emojis = getRuleEmojis(rule);
  const listed = emojis.includes(emoji);
  const matched = Boolean(emoji) && (emojis.length === 0 ? true : (rule.invert ? !listed : listed));
  return {
    input: serializeDebugValue(value),
    emoji,
    count,
    emojis,
    invert: Boolean(rule.invert),
    listed,
    matched,
    result: matched ? count : 0
  };
}


export function extractMentionAuthor(value, rule = {}) {
  return extractMentionAuthorDetails(value, rule).result;
}

export function extractMentionAuthorDetails(value, rule = {}) {
  const message = value && typeof value === 'object' && (value.text !== undefined || value.message !== undefined || value.entities || value.messageEntities)
    ? value
    : null;
  const text = message ? String(message.text || message.message || '') : '';
  const candidates = message ? getMessageEntitiesForAuthor(message) : [value].filter(Boolean);
  const allowedKinds = getConfiguredValues(rule).map((item) => String(item));
  const accepted = [];

  for (const entity of candidates) {
    const candidate = entityToAuthorCandidate(entity, text);
    if (!candidate.value) continue;
    if (allowedKinds.length && !allowedKinds.includes(candidate.kind)) continue;
    accepted.push(candidate);
  }

  const selected = accepted[0] || null;
  return {
    input: serializeDebugValue(value),
    allowedKinds,
    candidates: accepted.slice(0, 5).map((candidate) => ({
      kind: candidate.kind,
      type: candidate.type,
      value: candidate.value,
      userId: candidate.userId || null,
      url: candidate.url || ''
    })),
    result: selected?.value || ''
  };
}

function getMessageEntitiesForAuthor(message) {
  const entities = [];
  for (const key of ['entities', 'messageEntities']) {
    const value = message?.[key];
    if (Array.isArray(value)) entities.push(...value);
  }
  if (message?.raw && Array.isArray(message.raw.entities)) entities.push(...message.raw.entities);
  return entities;
}

function entityToAuthorCandidate(entity, text) {
  if (!entity || typeof entity !== 'object') {
    return { kind: '', type: '', value: '', userId: null, url: '' };
  }

  const type = String(entity._ || entity.type || entity.className || entity.kind || entity.constructor?.name || '').toLowerCase();
  const offset = Number(entity.offset ?? entity.start ?? 0);
  const length = Number(entity.length ?? 0);
  const slice = Number.isFinite(offset) && Number.isFinite(length) && length > 0
    ? text.slice(offset, offset + length).trim()
    : '';
  const url = String(entity.url || entity.href || '');
  const user = entity.user || entity.inputUser || entity.peer || null;
  const userIdRaw = entity.userId ?? entity.user_id ?? user?.id ?? user?.userId ?? user?.user_id ?? null;
  const userId = userIdRaw?.value ?? userIdRaw ?? null;
  const userName = formatMentionUser(user);

  if (type.includes('mentionname') || type.includes('text_mention') || userId) {
    return {
      kind: 'mentionName',
      type,
      value: slice || userName || (userId ? `tg://user?id=${userId}` : ''),
      userId,
      url
    };
  }

  if (url && /^tg:\/\/user\?id=\d+/i.test(url)) {
    return {
      kind: 'tgUser',
      type,
      value: slice || url,
      userId: url.match(/id=(\d+)/i)?.[1] || null,
      url
    };
  }

  if (type.includes('mention') || /^@[A-Za-z0-9_]{5,32}$/.test(slice)) {
    return {
      kind: 'username',
      type,
      value: slice.startsWith('@') ? slice : (slice ? `@${slice}` : ''),
      userId: null,
      url
    };
  }

  return { kind: '', type, value: '', userId: null, url };
}

function formatMentionUser(user) {
  if (!user || typeof user !== 'object') return '';
  const name = [user.firstName, user.lastName, user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  const username = user.username || user.userName;
  return username ? `@${username}` : '';
}

function getRuleEmojis(rule = {}) {
  const raw = rule.emojis ?? rule.emoji ?? rule.values ?? rule.value;
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((item) => String(item));
}

export function getSenderUserId(message) {
  return Number(
    message?.sender?.id ??
      message?.senderId?.value ??
      message?.senderId ??
      message?.fromId?.userId?.value ??
      message?.fromId?.userId ??
      0
  );
}

export function hasPhotoMedia(message) {
  return Boolean(
    message?.media?.type === 'photo' ||
      message?.photo ||
      message?.media?.photo ||
      message?.media?.className === 'MessageMediaPhoto'
  );
}

export function hasVideoMedia(message) {
  const document = message?.document || message?.media?.document || message?.media;
  const mimeType = document?.mimeType || '';
  return Boolean(
    message?.media?.type === 'video' ||
      message?.video ||
      message?.media?.video ||
      message?.media?.className === 'MessageMediaDocument' && mimeType.startsWith('video/')
  );
}

export function getMediaKind(message) {
  if (hasPhotoMedia(message)) return 'photo';
  if (hasVideoMedia(message)) return 'video';
  return 'text';
}

export function extractAuthor(text) {
  if (!text) return '';
  const match = text.match(/(?:^|\n)\s*(?:By|\u041e\u0442)\s+(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() || '';
}

export function buildMediaReference(message) {
  const photo = message?.media?.type === 'photo' ? message.media : message?.photo || message?.media?.photo;
  const document = message?.media?.type === 'video' || message?.media?.type === 'document'
    ? message.media
    : message?.document || message?.media?.document;
  const kind = getMediaKind(message);
  return {
    type: kind === 'text' ? 'telegram_text' : `telegram_${kind}`,
    messageId: Number(message.id),
    groupedId: message.groupedId ? String(message.groupedId) : null,
    mediaKind: kind,
    photoId: photo?.id ? String(photo.id) : null,
    documentId: document?.id ? String(document.id) : null,
    mimeType: document?.mimeType || null
  };
}

export function parsePostMessage(message, options) {
  if (!shouldReadMessage(message)) return null;

  const sender = message.sender || options.senderById?.get(getSenderUserId(message)) || null;
  const context = { message, sender };
  if (!passesFilters(context, options.parsing?.filters)) return null;

  const text = message.text || message.message || '';
  const fallbackReactions = parseReactions(message.markup || message.replyMarkup);
  const likes = extractNumber(context, options.parsing?.likes, fallbackReactions.likes);
  const dislikes = extractNumber(context, options.parsing?.dislikes, fallbackReactions.dislikes);
  const author = extractValue(context, options.parsing?.author) || extractAuthor(text) || formatSender(sender);
  const date = message.date instanceof Date ? message.date : new Date(Number(message.date) * 1000);

  return {
    chatId: options.chatId,
    messageId: Number(message.id),
    author,
    text,
    likes,
    dislikes,
    messageDate: date.toISOString(),
    data: {
      sender: sender ? compactSender(sender) : null,
      media: buildMediaReferences([message])
    }
  };
}

export function parseMessagesToPosts(messages, options) {
  const singles = [];
  const groups = new Map();

  for (const message of messages) {
    if (!shouldReadMessage(message)) continue;

    const groupKey = message.groupedId ? String(message.groupedId) : null;
    if (!groupKey) {
      const post = parsePostMessage(message, options);
      if (post) singles.push(post);
      continue;
    }

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(message);
  }

  const groupedPosts = [...groups.values()].map((group) => parseGroupedPost(group, options)).filter(Boolean);
  return [...singles, ...groupedPosts];
}

export function debugParseMessage(message, options) {
  const sender = message?.sender || options.senderById?.get(getSenderUserId(message)) || null;
  const context = { message, sender };
  const senderUserId = getSenderUserId(message);
  const shouldRead = shouldReadMessage(message);
  const fallbackReactions = parseReactions(message?.markup || message?.replyMarkup);

  const filters = traceFilters(context, options.parsing?.filters || []);
  const author = traceValueExtractors(context, options.parsing?.author || []);
  const likes = traceNumberExtractors(context, options.parsing?.likes || [], fallbackReactions.likes);
  const dislikes = traceNumberExtractors(context, options.parsing?.dislikes || [], fallbackReactions.dislikes);
  const post = parsePostMessage(message, options);

  return {
    messageId: Number(message?.id || 0),
    senderUserId,
    shouldRead,
    filterPassed: filters.passed,
    fallbackReactions,
    filters,
    extractors: {
      author,
      likes,
      dislikes
    },
    result: {
      matched: Boolean(post),
      post
    }
  };
}

export function shouldReadMessage(message) {
  return Boolean(message);
}

export function passesFilters(context, filters = []) {
  if (!filters?.length) return true;
  return filters.every((filter) => {
    const values = readExtractorValues(context, filter);
    const matched = values.some((value) => {
      const extracted = applyRegex(value, filter);
      if (extracted === undefined || extracted === null) return false;
      return Boolean(transformValue(extracted, filter.transform || 'bool', filter));
    });
    return isNegated(filter) ? !matched : matched;
  });
}

function traceFilters(context, filters = []) {
  if (!filters?.length) return { passed: true, rules: [] };
  const rules = filters.map((filter, index) => {
    const trace = traceRule(context, filter, filter.transform || 'bool');
    const matchedBeforeNegate = trace.values.some((value) => Boolean(value.transformed));
    const negated = isNegated(filter);
    return {
      index,
      rule: filter,
      pathTrace: trace.pathTrace,
      valuesCount: trace.values.length,
      matchedBeforeNegate,
      negated,
      passed: negated ? !matchedBeforeNegate : matchedBeforeNegate,
      values: trace.values
    };
  });
  return {
    passed: rules.every((rule) => rule.passed),
    rules
  };
}

function traceValueExtractors(context, extractors = []) {
  const rules = [];
  let selected = '';
  let selectedRule = null;

  for (let index = 0; index < extractors.length; index += 1) {
    const extractor = extractors[index];
    const trace = traceRule(context, extractor, extractor.transform);
    const accepted = trace.values.find((value) => (
      value.extracted !== undefined &&
      value.extracted !== null &&
      value.extracted !== '' &&
      value.transformed !== undefined &&
      value.transformed !== null &&
      value.transformed !== ''
    ));
    rules.push({
      index,
      rule: extractor,
      pathTrace: trace.pathTrace,
      valuesCount: trace.values.length,
      accepted: Boolean(accepted),
      values: trace.values
    });
    if (accepted && selected === '') {
      selected = accepted.transformed;
      selectedRule = index;
      break;
    }
  }

  return { selected, selectedRule, rules };
}

function traceNumberExtractors(context, extractors = [], fallback = 0) {
  if (!extractors?.length) {
    return {
      selected: fallback,
      fallbackUsed: true,
      fallback,
      fallbackReason: 'no extractor rules configured',
      fallbackSource: 'parseReactions(message.markup || message.replyMarkup)',
      rules: []
    };
  }

  const rules = [];
  let total = 0;
  let found = false;
  for (let index = 0; index < extractors.length; index += 1) {
    const extractor = extractors[index];
    const trace = traceRule(context, extractor, extractor.transform || 'count');
    const acceptedValues = trace.values
      .map((value, valueIndex) => ({
        valueIndex,
        input: value.input,
        extracted: value.extracted,
        transformed: Number(value.transformed)
      }))
      .filter((value) => !Number.isNaN(value.transformed));
    const subtotal = acceptedValues.reduce((sum, value) => sum + value.transformed, 0);
    if (acceptedValues.length) {
      found = true;
      total += subtotal;
    }
    rules.push({
      index,
      rule: extractor,
      source: extractor.source || 'message',
      path: extractor.path || '<root>',
      pathTrace: trace.pathTrace,
      pathMatched: trace.values.length > 0,
      valuesCount: trace.values.length,
      acceptedValues,
      subtotal,
      runningTotal: total,
      aggregate: extractor.aggregate || 'first',
      aggregateBehavior: extractor.aggregate === 'sum'
        ? 'sum matched values and continue to next extractor rule'
        : 'use first extractor rule that produced a number',
      values: trace.values
    });
    if (found && extractor.aggregate !== 'sum') break;
  }

  return {
    selected: found ? total : fallback,
    fallbackUsed: !found,
    fallback,
    fallbackReason: found ? null : 'extractor rules produced no numeric values',
    fallbackSource: found ? null : 'parseReactions(message.markup || message.replyMarkup)',
    rules
  };
}

export function extractValue(context, extractors = []) {
  for (const extractor of extractors || []) {
    const values = readExtractorValues(context, extractor);
    for (const value of values) {
      const extracted = applyRegex(value, extractor);
      if (extracted === undefined || extracted === null || extracted === '') continue;
      const transformed = transformValue(extracted, extractor.transform, extractor);
      if (transformed !== undefined && transformed !== null && transformed !== '') return transformed;
    }
  }
  return '';
}

export function extractNumber(context, extractors = [], fallback = 0) {
  if (!extractors?.length) return fallback;

  let total = 0;
  let found = false;
  for (const extractor of extractors) {
    const values = readExtractorValues(context, extractor);
    for (const value of values) {
      const extracted = applyRegex(value, extractor);
      if (extracted === undefined || extracted === null || extracted === '') continue;
      const transformed = Number(transformValue(extracted, extractor.transform || 'count', extractor));
      if (!Number.isNaN(transformed)) {
        found = true;
        total += transformed;
      }
    }
    if (found && extractor.aggregate !== 'sum') break;
  }

  return found ? total : fallback;
}

export function getValuesByPath(root, path) {
  if (!path) return [root];
  const parts = path.split('.');
  let values = [root];

  for (const part of parts) {
    values = resolvePathPart(values, part);
  }

  return values;
}

export function getPathTrace(root, path) {
  if (!path) return [{ part: '<root>', inputCount: 1, outputCount: 1, outputTypes: [describeValueType(root)] }];
  const trace = [];
  let values = [root];

  for (const part of path.split('.')) {
    const next = resolvePathPart(values, part);
    trace.push({
      part,
      inputCount: values.length,
      outputCount: next.length,
      outputTypes: [...new Set(next.map(describeValueType))].slice(0, 5)
    });
    values = next;
  }

  return trace;
}

function parseGroupedPost(group, options) {
  const ordered = [...group].sort((a, b) => Number(a.id) - Number(b.id));
  const representative = ordered.find((message) => message.replyMarkup) || ordered.find((message) => message.message) || ordered[0];
  const post = parsePostMessage(representative, options);
  if (!post) return null;

  post.data.media = buildMediaReferences(ordered);
  return post;
}

function buildMediaReferences(messages) {
  return messages
    .map((message) => buildMediaReference(message))
    .filter((media) => media.mediaKind !== 'text');
}

function readExtractorValues(context, extractor) {
  const source = extractor.source || 'message';
  const root = context[source];
  return getValuesByPath(root, extractor.path).flatMap((value) => Array.isArray(value) ? value : [value]);
}

function traceRule(context, extractor, transform) {
  const source = extractor.source || 'message';
  const root = context[source];
  const rawValues = getValuesByPath(root, extractor.path).flatMap((value) => Array.isArray(value) ? value : [value]);
  return {
    pathTrace: getPathTrace(root, extractor.path),
    values: rawValues.map((value) => {
      const extracted = applyRegex(value, extractor);
      const transformed = extracted === undefined || extracted === null ? undefined : transformValue(extracted, transform, extractor);
      const trace = {
        input: serializeDebugValue(value),
        extracted: serializeDebugValue(extracted),
        transform: transform || 'trim',
        transformDetails: getTransformDetails(extracted, transform, extractor),
        transformed: serializeDebugValue(transformed)
      };
      if (extractor.regex) {
        trace.regex = extractor.regex;
        trace.regexGroup = extractor.group || 0;
        trace.regexMatched = extracted !== undefined;
      }
      return trace;
    })
  };
}

function resolvePathPart(values, part) {
  const { key, arrayDepth } = parsePathPart(part);
  let next = values.flatMap((value) => readChildValues(value, key));

  for (let index = 0; index < arrayDepth; index += 1) {
    next = next.flatMap((value) => Array.isArray(value) ? value : []);
  }

  return next.filter((value) => value !== undefined && value !== null);
}

function parsePathPart(part) {
  const match = String(part).match(/^([^\[]*)((?:\[\])*)$/);
  return {
    key: match?.[1] || '',
    arrayDepth: (match?.[2]?.match(/\[\]/g) || []).length
  };
}

function readChildValues(value, key) {
  if (!key) return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => readChildValues(item, key));
  }
  return [value?.[key]];
}

function describeValueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function applyRegex(value, extractor) {
  if (!extractor.regex) return value;
  const match = String(value).match(new RegExp(extractor.regex, extractor.flags || 'i'));
  if (!match) return undefined;
  return match[extractor.group || 0];
}

function transformValue(value, transform, rule = {}) {
  if (transform === 'count') return parseCount(value);
  if (transform === 'reactionCount') return parseReactionCount(value, rule);
  if (transform === 'mentionAuthor') return extractMentionAuthor(value, rule);
  if (transform === 'telegramUsername') return String(value).startsWith('@') ? String(value) : `@${value}`;
  if (transform === 'exists') return value !== undefined && value !== null && String(value).trim() !== '';
  if (transform === 'notEmpty') return String(value).trim().length > 0;
  if (transform === 'contains') return containsConfiguredValue(value, rule);
  if (transform === 'equals') return equalsConfiguredValue(value, rule);
  if (transform === 'in') return equalsConfiguredValue(value, rule);
  if (transform === 'isPhoto') return getMediaKind(value) === 'photo';
  if (transform === 'isVideo') return getMediaKind(value) === 'video';
  if (transform === 'hasMedia') return getMediaKind(value) !== 'text';
  if (transform === 'hasContent') return getMediaKind(value) !== 'text' || String(value?.text || value?.message || '').trim().length > 0;
  if (transform === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return String(value).trim().length > 0;
  }
  return String(value).trim();
}

function getTransformDetails(value, transform, rule = {}) {
  if (value === undefined || value === null) return null;
  if (transform === 'count') return parseCountDetails(value);
  if (transform === 'reactionCount') return parseReactionCountDetails(value, rule);
  if (transform === 'mentionAuthor') return extractMentionAuthorDetails(value, rule);
  if (transform === 'telegramUsername') {
    return {
      input: serializeDebugValue(value),
      alreadyPrefixed: String(value).startsWith('@'),
      result: transformValue(value, transform, rule)
    };
  }
  if (transform === 'contains') {
    return {
      input: serializeDebugValue(value),
      values: getConfiguredValues(rule),
      caseSensitive: Boolean(rule.caseSensitive),
      result: transformValue(value, transform, rule)
    };
  }
  if (transform === 'equals' || transform === 'in') {
    return {
      input: serializeDebugValue(value),
      values: getConfiguredValues(rule),
      caseSensitive: Boolean(rule.caseSensitive),
      result: transformValue(value, transform, rule)
    };
  }
  if (['exists', 'notEmpty', 'isPhoto', 'isVideo', 'hasMedia', 'hasContent', 'bool'].includes(transform)) {
    return {
      input: serializeDebugValue(value),
      result: transformValue(value, transform, rule)
    };
  }
  return {
    input: serializeDebugValue(value),
    trim: true,
    result: transformValue(value, transform, rule)
  };
}

function isNegated(rule) {
  return Boolean(rule?.negate || rule?.not);
}

function containsConfiguredValue(value, rule) {
  const needles = getConfiguredValues(rule);
  if (!needles.length) return false;
  const input = normalizeComparable(value, rule.caseSensitive);
  return needles.some((needle) => input.includes(normalizeComparable(needle, rule.caseSensitive)));
}

function equalsConfiguredValue(value, rule) {
  const expected = getConfiguredValues(rule);
  if (!expected.length) return false;
  const input = normalizeComparable(value, rule.caseSensitive);
  return expected.some((item) => input === normalizeComparable(item, rule.caseSensitive));
}

function getConfiguredValues(rule = {}) {
  const raw = rule.values ?? rule.value ?? rule.contains ?? rule.equals ?? rule.in;
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function normalizeComparable(value, caseSensitive = false) {
  const text = String(value);
  return caseSensitive ? text : text.toLowerCase();
}

function formatSender(sender) {
  if (!sender) return '';
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (sender.username) return `@${sender.username}`;
  return '';
}

function compactSender(sender) {
  return {
    id: sender.id ? String(sender.id.value ?? sender.id) : null,
    firstName: sender.firstName || '',
    lastName: sender.lastName || '',
    username: sender.username || ''
  };
}

function serializeDebugValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  try {
    return truncate(JSON.stringify(value, (_, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      return item;
    }));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function truncate(value, maxLength = 500) {
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
