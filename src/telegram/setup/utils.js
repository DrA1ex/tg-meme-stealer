import { DEFAULT_PREVIEW_MESSAGES, DEFAULT_PREVIEW_POSTS } from './constants.js';

export function replaceObjectContents(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

export function getArgument(text = '') {
  return text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
}

export function splitFirstArgument(text) {
  const argument = getArgument(text);
  const match = argument.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? [match[1], match[2]] : [argument, ''];
}

export function parseLimit(text, fallback) {
  const raw = getArgument(text);
  if (!raw) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Limit must be an integer from 1 to 1000');
  }
  return limit;
}

export function parseMessageId(text) {
  const raw = getArgument(text);
  const messageId = Number(raw);
  if (!Number.isInteger(messageId) || messageId < 1) {
    throw new Error('Message id must be a positive integer');
  }
  return messageId;
}

export function parsePreviewArgs(text) {
  const raw = getArgument(text);
  if (!raw) return { postCount: DEFAULT_PREVIEW_POSTS, messageCount: DEFAULT_PREVIEW_MESSAGES };
  const parts = raw.split(/\s+/).map(Number);
  const [postCount, messageCount = DEFAULT_PREVIEW_MESSAGES] = parts;

  if (!Number.isInteger(postCount) || postCount < 1 || postCount > 20) {
    throw new Error('Post count must be an integer from 1 to 20');
  }
  if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 1000) {
    throw new Error('Message count must be an integer from 1 to 1000');
  }
  return { postCount, messageCount };
}

export async function replyCode(ctx, text) {
  const limit = 3400;
  for (let index = 0; index < text.length; index += limit) {
    const chunk = text.slice(index, index + limit);
    await ctx.reply(`<pre><code>${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

export async function replyJsonCode(ctx, value) {
  const json = stringifyForSetup(value);
  const chunkSize = 3400;
  for (let index = 0; index < json.length; index += chunkSize) {
    const chunk = json.slice(index, index + chunkSize);
    await ctx.reply(`<pre><code class="language-json">${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

export async function replyJsonFile(ctx, value, filename) {
  const json = stringifyForSetup(value);
  await ctx.replyWithDocument({
    source: Buffer.from(`${json}\n`, 'utf8'),
    filename
  });
}

export function stringifyForSetup(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  }, 2) ?? 'null';
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
