import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPosts,
  setParsingRules,
  setTemplateValue,
  summarizeParsedPosts
} from '../core/setupConfig.js';
import { sendRichPost } from './richPost.js';

const SETUP_HELP = [
  'Setup mode commands:',
  '/setfilter <json rule or array>',
  '/addfilter <json rule or array>',
  '/setauthor <json rule or array>',
  '/setlikes <json rule or array>',
  '/setdislikes <json rule or array>',
  '/settemplate <key> <value>',
  '/test [message_count]',
  '/raw <message_id>',
  '/test_message <message_id>',
  '/debug <message_id>',
  '/preview [post_count] [message_count]',
  '/done',
  '/cancel'
].join('\n');

export class SetupAssistant {
  constructor({ scanner, mediaDownloader, config }) {
    this.scanner = scanner;
    this.mediaDownloader = mediaDownloader;
    this.config = config;
    this.sessions = new Map();
  }

  register(bot) {
    bot.command('setup', (ctx) => this.start(ctx));
    bot.command('setfilter', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'filters')));
    bot.command('addfilter', (ctx) => this.withSession(ctx, () => this.addRules(ctx, 'filters')));
    bot.command('setauthor', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'author')));
    bot.command('setlikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'likes')));
    bot.command('setdislikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'dislikes')));
    bot.command('settemplate', (ctx) => this.withSession(ctx, () => this.setTemplate(ctx)));
    bot.command('test', (ctx) => this.withSession(ctx, () => this.test(ctx)));
    bot.command('raw', (ctx) => this.withSession(ctx, () => this.raw(ctx)));
    bot.command('test_message', (ctx) => this.withSession(ctx, () => this.testMessage(ctx)));
    bot.command('debug', (ctx) => this.withSession(ctx, () => this.debug(ctx)));
    bot.command('preview', (ctx) => this.withSession(ctx, () => this.preview(ctx)));
    bot.command('done', (ctx) => this.withSession(ctx, () => this.done(ctx)));
    bot.command('cancel', (ctx) => this.cancel(ctx));
  }

  async start(ctx) {
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
    await ctx.reply(`${SETUP_HELP}\n\nCurrent draft:`);
    await replyJsonCode(ctx, JSON.parse(formatDraftConfig(this.getDraft(ctx))));
  }

  async setRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    setParsingRules(this.getDraft(ctx), key, rules);
    await ctx.reply(`${key} replaced. Run /test 30 to check.`);
  }

  async addRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    addParsingRule(this.getDraft(ctx), key, rules);
    await ctx.reply(`${key} appended. Run /test 30 to check.`);
  }

  async setTemplate(ctx) {
    const [key, value] = splitFirstArgument(ctx.message.text);
    if (!key || !value) throw new Error('Usage: /settemplate <key> <value>');
    setTemplateValue(this.getDraft(ctx), key, value);
    await ctx.reply(`${key} template updated. Run /preview 30 to check.`);
  }

  async test(ctx) {
    const limit = parseLimit(ctx.message.text, 30);
    const result = await this.scanner.previewRecent(limit, this.getDraft(ctx));
    await replyCode(ctx, summarizeParsedPosts(result));
  }

  async raw(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const message = await this.scanner.getMessageById(messageId);
    if (!message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyJsonFile(ctx, message, `telegram-message-${messageId}.json`);
  }

  async testMessage(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const result = await this.scanner.previewMessage(messageId, this.getDraft(ctx));
    if (!result.message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyCode(ctx, summarizeParsedPosts({ scanned: 1, posts: result.posts }));
    if (!result.posts.length) {
      await ctx.reply('Message did not match the current parser rules.');
      return;
    }
    await replyJsonCode(ctx, result.posts.length === 1 ? result.posts[0] : result.posts);
  }

  async debug(ctx) {
    const messageId = parseMessageId(ctx.message.text);
    const result = await this.scanner.debugMessage(messageId, this.getDraft(ctx));
    if (!result.message) {
      await ctx.reply(`Message not found: ${messageId}`);
      return;
    }
    await replyJsonFile(ctx, result.debug, `telegram-message-${messageId}-debug.json`);
  }

  async preview(ctx) {
    const { postCount, messageCount } = parsePreviewArgs(ctx.message.text);
    const result = await this.scanner.previewRecent(messageCount, this.getDraft(ctx));
    const posts = selectWeekPreviewPosts(result.posts, postCount);
    const draft = this.getDraft(ctx);
    await ctx.reply(`Preview source: ${result.posts.length} matched posts from ${result.scanned} scanned messages. Showing ${posts.length}.`);

    if (!posts.length) {
      await ctx.reply(formatPreviewPost(null, draft.templates));
      return;
    }

    for (let index = 0; index < posts.length; index += 1) {
      await sendRichPost({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        mediaDownloader: this.mediaDownloader,
        post: posts[index],
        index,
        templates: draft.templates
      });
    }
  }

  async done(ctx) {
    const draft = this.getDraft(ctx);
    const result = await saveDraftConfig(draft);
    await ctx.reply([
      `Config saved: ${result.configPath}`,
      `Backup: ${result.backupPath}`,
      '',
      'Final config snippet:'
    ].join('\n'));
    await replyJsonCode(ctx, JSON.parse(formatDraftConfig(draft)));
    this.sessions.delete(ctx.from.id);
  }

  async cancel(ctx) {
    this.sessions.delete(ctx.from.id);
    await ctx.reply('Setup mode cancelled.');
  }

  async withSession(ctx, handler) {
    if (!this.sessions.has(ctx.from.id)) {
      await ctx.reply('Setup mode is not active. Run /setup first.');
      return;
    }

    try {
      await handler();
    } catch (error) {
      await ctx.reply(`Setup error: ${error.message}`);
    }
  }

  getDraft(ctx) {
    return this.sessions.get(ctx.from.id);
  }
}

function getArgument(text) {
  return text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
}

function splitFirstArgument(text) {
  const argument = getArgument(text);
  const match = argument.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? [match[1], match[2]] : [argument, ''];
}

function parseLimit(text, fallback) {
  const raw = getArgument(text);
  if (!raw) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Limit must be an integer from 1 to 1000');
  }
  return limit;
}

function parseMessageId(text) {
  const raw = getArgument(text);
  const messageId = Number(raw);
  if (!Number.isInteger(messageId) || messageId < 1) {
    throw new Error('Message id must be a positive integer');
  }
  return messageId;
}

function parsePreviewArgs(text) {
  const raw = getArgument(text);
  if (!raw) return { postCount: 1, messageCount: 30 };
  const parts = raw.split(/\s+/).map(Number);
  const [postCount, messageCount = 30] = parts;

  if (!Number.isInteger(postCount) || postCount < 1 || postCount > 20) {
    throw new Error('Post count must be an integer from 1 to 20');
  }
  if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > 1000) {
    throw new Error('Message count must be an integer from 1 to 1000');
  }
  return { postCount, messageCount };
}

async function replyLong(ctx, text) {
  const limit = 3900;
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (`${chunk}\n${line}`.length > limit) {
      await ctx.reply(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }

  if (chunk) await ctx.reply(chunk);
}

async function replyCode(ctx, text) {
  const limit = 3400;
  for (let index = 0; index < text.length; index += limit) {
    const chunk = text.slice(index, index + limit);
    await ctx.reply(`<pre><code>${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

async function replyJsonCode(ctx, value) {
  const json = stringifyForSetup(value);
  const chunkSize = 3400;
  for (let index = 0; index < json.length; index += chunkSize) {
    const chunk = json.slice(index, index + chunkSize);
    await ctx.reply(`<pre><code class="language-json">${escapeHtml(chunk)}</code></pre>`, { parse_mode: 'HTML' });
  }
}

async function replyJsonFile(ctx, value, filename) {
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
