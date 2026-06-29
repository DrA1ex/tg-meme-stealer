import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPost,
  setParsingRules,
  setSourceMode,
  setTemplateValue,
  summarizeParsedPosts
} from '../core/setupConfig.js';

const SETUP_HELP = [
  'Setup mode commands:',
  '/mode user|all',
  '/setfilter <json rule or array>',
  '/addfilter <json rule or array>',
  '/setauthor <json rule or array>',
  '/setlikes <json rule or array>',
  '/setdislikes <json rule or array>',
  '/settemplate <key> <value>',
  '/test [message_count]',
  '/preview [message_count]',
  '/done',
  '/cancel'
].join('\n');

export class SetupAssistant {
  constructor({ scanner, config }) {
    this.scanner = scanner;
    this.config = config;
    this.sessions = new Map();
  }

  register(bot) {
    bot.command('setup', (ctx) => this.start(ctx));
    bot.command('mode', (ctx) => this.withSession(ctx, () => this.mode(ctx)));
    bot.command('setfilter', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'filters')));
    bot.command('addfilter', (ctx) => this.withSession(ctx, () => this.addRules(ctx, 'filters')));
    bot.command('setauthor', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'author')));
    bot.command('setlikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'likes')));
    bot.command('setdislikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'dislikes')));
    bot.command('settemplate', (ctx) => this.withSession(ctx, () => this.setTemplate(ctx)));
    bot.command('test', (ctx) => this.withSession(ctx, () => this.test(ctx)));
    bot.command('preview', (ctx) => this.withSession(ctx, () => this.preview(ctx)));
    bot.command('done', (ctx) => this.withSession(ctx, () => this.done(ctx)));
    bot.command('cancel', (ctx) => this.cancel(ctx));
  }

  async start(ctx) {
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
    await ctx.reply(`${SETUP_HELP}\n\nCurrent draft:\n${formatDraftConfig(this.getDraft(ctx))}`);
  }

  async mode(ctx) {
    const mode = getArgument(ctx.message.text);
    setSourceMode(this.getDraft(ctx), mode);
    await ctx.reply(`Mode set: ${mode}`);
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
    await replyLong(ctx, summarizeParsedPosts(result));
  }

  async preview(ctx) {
    const limit = parseLimit(ctx.message.text, 30);
    const result = await this.scanner.previewRecent(limit, this.getDraft(ctx));
    const post = selectWeekPreviewPost(result.posts);
    const draft = this.getDraft(ctx);
    await ctx.reply([
      `Preview source: ${result.posts.length} matched posts from ${result.scanned} scanned messages.`,
      '',
      formatPreviewPost(post, draft.templates)
    ].join('\n'));
  }

  async done(ctx) {
    const draft = this.getDraft(ctx);
    const result = await saveDraftConfig(draft);
    await ctx.reply([
      `Config saved: ${result.configPath}`,
      `Backup: ${result.backupPath}`,
      '',
      `Final config snippet:\n${formatDraftConfig(draft)}`
    ].join('\n'));
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
