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
  if (!shouldReadMessage(message, options)) {
    return null;
  }

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
    if (!shouldReadMessage(message, options)) {
      continue;
    }

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
  const sourceMode = options.sourceMode || options.source?.mode || 'user';
  const senderUserId = getSenderUserId(message);
  const shouldRead = shouldReadMessage(message, options);
  const fallbackReactions = parseReactions(message?.markup || message?.replyMarkup);

  const filters = traceFilters(context, options.parsing?.filters || []);
  const author = traceValueExtractors(context, options.parsing?.author || []);
  const likes = traceNumberExtractors(context, options.parsing?.likes || [], fallbackReactions.likes);
  const dislikes = traceNumberExtractors(context, options.parsing?.dislikes || [], fallbackReactions.dislikes);
  const post = parsePostMessage(message, options);

  return {
    messageId: Number(message?.id || 0),
    sourceMode,
    senderUserId,
    targetUserId: options.targetUserId,
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

export function shouldReadMessage(message, options) {
  if (!message) return false;
  const mode = options.sourceMode || options.source?.mode || 'user';
  if (mode === 'all') return true;
  return getSenderUserId(message) === Number(options.targetUserId);
}

export function passesFilters(context, filters = []) {
  if (!filters?.length) return true;
  return filters.every((filter) => {
    const values = readExtractorValues(context, filter);
    if (!values.length) return false;
    return values.some((value) => {
      const extracted = applyRegex(value, filter);
      if (extracted === undefined || extracted === null) return false;
      return Boolean(transformValue(extracted, filter.transform || 'bool'));
    });
  });
}

function traceFilters(context, filters = []) {
  if (!filters?.length) return { passed: true, rules: [] };
  const rules = filters.map((filter, index) => {
    const trace = traceRule(context, filter, filter.transform || 'bool');
    return {
      index,
      rule: filter,
      pathTrace: trace.pathTrace,
      valuesCount: trace.values.length,
      passed: trace.values.some((value) => Boolean(value.transformed)),
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
      const transformed = transformValue(extracted, extractor.transform);
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
      const transformed = Number(transformValue(extracted, extractor.transform || 'count'));
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
      const transformed = extracted === undefined || extracted === null ? undefined : transformValue(extracted, transform);
      const trace = {
        input: serializeDebugValue(value),
        extracted: serializeDebugValue(extracted),
        transform: transform || 'trim',
        transformDetails: getTransformDetails(extracted, transform),
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

function transformValue(value, transform) {
  if (transform === 'count') return parseCount(value);
  if (transform === 'telegramUsername') return String(value).startsWith('@') ? String(value) : `@${value}`;
  if (transform === 'exists') return value !== undefined && value !== null && String(value).trim() !== '';
  if (transform === 'notEmpty') return String(value).trim().length > 0;
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

function getTransformDetails(value, transform) {
  if (value === undefined || value === null) return null;
  if (transform === 'count') return parseCountDetails(value);
  if (transform === 'telegramUsername') {
    return {
      input: serializeDebugValue(value),
      alreadyPrefixed: String(value).startsWith('@'),
      result: transformValue(value, transform)
    };
  }
  if (['exists', 'notEmpty', 'isPhoto', 'isVideo', 'hasMedia', 'hasContent', 'bool'].includes(transform)) {
    return {
      input: serializeDebugValue(value),
      result: transformValue(value, transform)
    };
  }
  return {
    input: serializeDebugValue(value),
    trim: true,
    result: transformValue(value, transform)
  };
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
