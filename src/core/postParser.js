const DEFAULT_LIKE_MARKERS = ['👍', '❤', '❤️', '🔥', '+'];
const DEFAULT_DISLIKE_MARKERS = ['👎', '-'];

export function parseCount(value) {
  if (!value) return 0;
  const normalized = String(value).replace(',', '.').replace(/\s+/g, '');
  const match = normalized.match(/(\d+(?:\.\d+)?)([k\u043am\u043c])?/i);
  if (!match) return 0;

  const number = Number.parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k' || suffix === '\u043a') return Math.round(number * 1000);
  if (suffix === 'm' || suffix === '\u043c') return Math.round(number * 1000000);
  return Math.round(number);
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
      media: buildMediaReferences([message]),
      images: buildMediaReferences([message]).filter((media) => media.mediaKind === 'photo')
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
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next = [];
    for (const value of values) {
      const child = key ? value?.[key] : value;
      if (isArray) {
        if (Array.isArray(child)) next.push(...child);
      } else if (child !== undefined && child !== null) {
        next.push(child);
      }
    }
    values = next;
  }

  return values;
}

function parseGroupedPost(group, options) {
  const ordered = [...group].sort((a, b) => Number(a.id) - Number(b.id));
  const representative = ordered.find((message) => message.replyMarkup) || ordered.find((message) => message.message) || ordered[0];
  const post = parsePostMessage(representative, options);
  if (!post) return null;

  post.data.media = buildMediaReferences(ordered);
  post.data.images = post.data.media.filter((media) => media.mediaKind === 'photo');
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
