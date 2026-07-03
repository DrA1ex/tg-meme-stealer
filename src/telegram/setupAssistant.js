import {
  addParsingRule,
  createSetupDraft,
  formatDraftConfig,
  formatPreviewPost,
  parseJsonArgument,
  saveDraftConfig,
  selectWeekPreviewPosts,
  setPublishSources,
  setPublishTemplate,
  upsertPublishSource,
  setParsingRules,
  setTemplateValue,
  summarizeParsedPosts,
  validateSetupDraft
} from '../core/setupConfig.js';
import { loadConfig } from '../config/index.js';
import { sendRichPost } from './richPost.js';

const DEFAULT_TEST_MESSAGES = 30;
const DEFAULT_PREVIEW_MESSAGES = 100;
const DEFAULT_PREVIEW_POSTS = 5;

const ADVANCED_HELP = [
  'Advanced setup commands:',
  '',
  'Parser JSON:',
  '/setfilter <json rule or array>',
  '/addfilter <json rule or array>',
  '/setauthor <json rule or array>',
  '/setlikes <json rule or array>',
  '/setdislikes <json rule or array>',
  '',
  'Publishing JSON:',
  '/setsources <json array>',
  '/setsource <json object>',
  '/setpublish <json object>',
  '/settemplate <key> <value>',
  '',
  'Inspection:',
  '/test [message_count]',
  '/preview [post_count] [message_count]',
  '/raw <message_id>',
  '/test_message <message_id>',
  '/debug <message_id>',
  '',
  'Finish:',
  '/done',
  '/cancel',
  '',
  'These commands are kept for precise manual tuning. The main /setup flow now uses buttons first.'
].join('\n');

export class SetupAssistant {
  constructor({ scanner, mediaDownloader, config, configLoader = loadConfig }) {
    this.scanner = scanner;
    this.mediaDownloader = mediaDownloader;
    this.config = config;
    this.configLoader = configLoader;
    this.sessions = new Map();
  }

  register(bot) {
    bot.command('setup', (ctx) => this.setupCommand(ctx));
    bot.action(/^setup:(.+)$/, (ctx) => this.setupAction(ctx));
    bot.command('setfilter', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'filters')));
    bot.command('addfilter', (ctx) => this.withSession(ctx, () => this.addRules(ctx, 'filters')));
    bot.command('setauthor', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'author')));
    bot.command('setlikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'likes')));
    bot.command('setdislikes', (ctx) => this.withSession(ctx, () => this.setRules(ctx, 'dislikes')));
    bot.command('setsources', (ctx) => this.withSession(ctx, () => this.setSources(ctx)));
    bot.command('setsource', (ctx) => this.withSession(ctx, () => this.setSource(ctx)));
    bot.command('setpublish', (ctx) => this.withSession(ctx, () => this.setPublish(ctx)));
    bot.command('settemplate', (ctx) => this.withSession(ctx, () => this.setTemplate(ctx)));
    bot.command('test', (ctx) => this.withSession(ctx, () => this.test(ctx)));
    bot.command('raw', (ctx) => this.withSession(ctx, () => this.raw(ctx)));
    bot.command('test_message', (ctx) => this.withSession(ctx, () => this.testMessage(ctx)));
    bot.command('debug', (ctx) => this.withSession(ctx, () => this.debug(ctx)));
    bot.command('preview', (ctx) => this.withSession(ctx, () => this.preview(ctx)));
    bot.command('done', (ctx) => this.withSession(ctx, () => this.done(ctx)));
    bot.command('cancel', (ctx) => this.cancel(ctx));
  }

  async setupCommand(ctx) {
    const action = getArgument(ctx.message.text).toLowerCase();
    if (!action) {
      await this.start(ctx);
      return;
    }

    if (action === 'status') {
      this.ensureSession(ctx);
      await this.status(ctx);
      return;
    }
    if (action === 'doctor') {
      this.ensureSession(ctx);
      await this.doctor(ctx);
      return;
    }
    if (action === 'preview') {
      this.ensureSession(ctx);
      await this.previewDefaults(ctx);
      return;
    }
    if (action === 'parser') {
      this.ensureSession(ctx);
      await this.parserMenu(ctx);
      return;
    }
    if (action === 'publish') {
      this.ensureSession(ctx);
      await this.publishMenu(ctx);
      return;
    }
    if (action === 'advanced') {
      this.ensureSession(ctx);
      await this.advanced(ctx);
      return;
    }
    if (action === 'config') {
      this.ensureSession(ctx);
      await this.showDraftConfig(ctx);
      return;
    }
    if (action === 'save') {
      await this.withSession(ctx, () => this.done(ctx));
      return;
    }
    if (action === 'cancel') {
      await this.cancel(ctx);
      return;
    }

    await ctx.reply(
      `Unknown setup action: ${action}\n\nUse /setup or choose a button from the setup menu.`,
      setupMenuKeyboard()
    );
  }

  async setupAction(ctx) {
    const action = ctx.match?.[1] || '';
    await ctx.answerCbQuery().catch(() => {});

    try {
      if (action === 'start' || action === 'restart') {
        await this.start(ctx);
        return;
      }

      if (action === 'cancel') {
        await this.cancel(ctx);
        return;
      }

      this.ensureSession(ctx);

      if (action === 'status') {
        await this.status(ctx);
      } else if (action === 'doctor') {
        await this.doctor(ctx);
      } else if (action === 'preview') {
        await this.previewDefaults(ctx);
      } else if (action === 'test') {
        await this.testDefaults(ctx);
      } else if (action === 'parser') {
        await this.parserMenu(ctx);
      } else if (action === 'publish') {
        await this.publishMenu(ctx);
      } else if (action === 'advanced') {
        await this.advanced(ctx);
      } else if (action === 'config') {
        await this.showDraftConfig(ctx);
      } else if (action === 'save') {
        await this.done(ctx);
      } else {
        await ctx.reply(`Unknown setup button: ${action}`, setupMenuKeyboard());
      }
    } catch (error) {
      await ctx.reply(`Setup error: ${error.message}`, setupMenuKeyboard());
    }
  }

  async start(ctx) {
    this.reloadConfig();
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
    await ctx.reply(formatSetupIntro(this.getDraft(ctx)), setupMenuKeyboard());
  }

  async status(ctx) {
    await ctx.reply(formatSetupStatus(this.getDraft(ctx), this.config), setupMenuKeyboard());
  }

  async parserMenu(ctx) {
    await ctx.reply(formatParserMenu(this.getDraft(ctx)), parserMenuKeyboard());
  }

  async publishMenu(ctx) {
    await ctx.reply(formatPublishMenu(this.getDraft(ctx), this.config), publishMenuKeyboard());
  }

  async advanced(ctx) {
    await ctx.reply(ADVANCED_HELP, advancedMenuKeyboard());
  }

  async showDraftConfig(ctx) {
    await ctx.reply('Current setup draft:');
    await replyJsonCode(ctx, JSON.parse(formatDraftConfig(this.getDraft(ctx))));
    await ctx.reply('Use the buttons to continue setup.', setupMenuKeyboard());
  }

  async doctor(ctx) {
    const draft = this.getDraft(ctx);
    await ctx.reply(`Running setup doctor on the latest ${DEFAULT_TEST_MESSAGES} source messages...`);
    const result = await this.scanner.previewRecent(DEFAULT_TEST_MESSAGES, draft);
    await ctx.reply(formatSetupDoctor({ draft, baseConfig: this.config, preview: result }), setupMenuKeyboard());
  }

  async testDefaults(ctx) {
    const result = await this.scanner.previewRecent(DEFAULT_TEST_MESSAGES, this.getDraft(ctx));
    await replyCode(ctx, summarizeParsedPosts(result, { maxRows: 12 }));
    await ctx.reply('Parser test finished.', parserMenuKeyboard());
  }

  async previewDefaults(ctx) {
    await this.sendPreview(ctx, {
      postCount: DEFAULT_PREVIEW_POSTS,
      messageCount: DEFAULT_PREVIEW_MESSAGES
    });
  }

  async setRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    setParsingRules(this.getDraft(ctx), key, rules);
    await ctx.reply(`${key} replaced. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async addRules(ctx, key) {
    const rules = parseJsonArgument(ctx.message.text);
    addParsingRule(this.getDraft(ctx), key, rules);
    await ctx.reply(`${key} appended. Use Test parser or Preview to check the result.`, parserMenuKeyboard());
  }

  async setTemplate(ctx) {
    const [key, value] = splitFirstArgument(ctx.message.text);
    if (!key || !value) throw new Error('Usage: /settemplate <key> <value>');
    setTemplateValue(this.getDraft(ctx), key, value);
    await ctx.reply(`${key} template updated. Use Preview to check the result.`, setupMenuKeyboard());
  }

  async setSources(ctx) {
    const sources = parseJsonArgument(ctx.message.text);
    setPublishSources(this.getDraft(ctx), sources);
    await ctx.reply('publish.sources replaced. Run Doctor or Save when ready.', publishMenuKeyboard());
  }

  async setSource(ctx) {
    const source = parseJsonArgument(ctx.message.text);
    upsertPublishSource(this.getDraft(ctx), source);
    await ctx.reply(`publish.sources.${source.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async setPublish(ctx) {
    const template = parseJsonArgument(ctx.message.text);
    setPublishTemplate(this.getDraft(ctx), template);
    await ctx.reply(`publish.template.${template.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
  }

  async test(ctx) {
    const limit = parseLimit(ctx.message.text, DEFAULT_TEST_MESSAGES);
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
    const args = parsePreviewArgs(ctx.message.text);
    await this.sendPreview(ctx, args);
  }

  async sendPreview(ctx, { postCount, messageCount }) {
    const result = await this.scanner.previewRecent(messageCount, this.getDraft(ctx));
    const posts = selectWeekPreviewPosts(result.posts, postCount);
    const draft = this.getDraft(ctx);
    await ctx.reply([
      `Preview source: ${result.posts.length} matched posts from ${result.scanned} scanned messages.`,
      `Showing ${posts.length} selected post(s).`,
      '',
      'Phase 2 will add automatic parser suggestions here; for now use Advanced JSON if the match set is wrong.'
    ].join('\n'), previewMenuKeyboard());

    if (!posts.length) {
      await ctx.reply(formatPreviewPost(null, draft.templates), previewMenuKeyboard());
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
    validateSetupDraft(draft, this.config);
    const result = await saveDraftConfig(draft);
    this.reloadConfig();
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
      await ctx.reply(`Setup error: ${error.message}`, setupMenuKeyboard());
    }
  }

  ensureSession(ctx) {
    if (this.sessions.has(ctx.from.id)) return;
    this.reloadConfig();
    this.sessions.set(ctx.from.id, createSetupDraft(this.config));
  }

  getDraft(ctx) {
    return this.sessions.get(ctx.from.id);
  }

  reloadConfig() {
    replaceObjectContents(this.config, this.configLoader());
  }
}

function formatSetupIntro(draft) {
  return [
    'Setup mode started.',
    '',
    'Use buttons for the common flow: check status, run doctor, preview selected posts, then save.',
    'Advanced JSON commands are still available, but they are no longer the main path.',
    '',
    formatSetupStatus(draft)
  ].join('\n');
}

function formatSetupStatus(draft, baseConfig = {}) {
  const parsing = draft.parsing || {};
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const enabledTemplates = templates.filter((template) => template.enabled !== false);
  const disabledTemplates = templates.length - enabledTemplates.length;
  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);

  return [
    'Setup status',
    '',
    `Parser: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author rule(s), ${countRules(parsing.likes)} like rule(s), ${countRules(parsing.dislikes)} dislike rule(s).`,
    `Publishing: ${templates.length} template(s), ${enabledTemplates.length} enabled, ${disabledTemplates} disabled, ${sources.length} source(s).`,
    `Runtime: dryRun=${Boolean(publish.dryRun)}, timezone=${baseConfig.schedule?.timezone || 'default'}.`,
    firstSendAt ? `First send gate: ${firstSendAt}` : 'First send gate: not set.',
    '',
    'Enabled templates:',
    ...formatTemplateLines(enabledTemplates),
    '',
    'Next steps:',
    '- Doctor checks obvious config and parser issues.',
    '- Preview sends real candidate posts to this chat.',
    '- Phase 2 will add automatic parser/reaction suggestions.',
    '- Phase 3 will add publish presets such as daily top, morning/night, weekly and controversial.'
  ].join('\n');
}

function formatParserMenu(draft) {
  const parsing = draft.parsing || {};
  return [
    'Parser setup',
    '',
    `Current rules: ${countRules(parsing.filters)} filter(s), ${countRules(parsing.author)} author, ${countRules(parsing.likes)} likes, ${countRules(parsing.dislikes)} dislikes.`,
    '',
    'Available now:',
    '- Test parser scans recent messages and shows matched rows.',
    '- Preview sends selected rich posts.',
    '- Advanced JSON lets you edit exact rules.',
    '',
    'Phase 2 target: detect media/text/sender filters, author lines, and reaction buttons automatically, then offer them as buttons.'
  ].join('\n');
}

function formatPublishMenu(draft, baseConfig = {}) {
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  return [
    'Publishing setup',
    '',
    `Sources: ${sources.length}`,
    `Templates: ${templates.length}`,
    `Timezone: ${baseConfig.schedule?.timezone || 'default'}`,
    '',
    ...formatTemplateLines(templates, { includeDisabled: true }),
    '',
    'Available now:',
    '- Status and Doctor explain the current config.',
    '- Advanced JSON edits exact sources/templates.',
    '',
    'Phase 3 target: button presets for Daily top, Morning + night top, Weekly top, Monthly top, and Controversial.'
  ].join('\n');
}

function formatSetupDoctor({ draft, baseConfig, preview }) {
  const warnings = [];
  const notes = [];
  const publish = draft.publish || {};
  const templates = Array.isArray(publish.template) ? publish.template : [];
  const sources = Array.isArray(publish.sources) ? publish.sources : [];
  const sourceKeys = new Set(sources.map((source) => source.key));

  try {
    validateSetupDraft(draft, baseConfig);
    notes.push('Config validation: ok.');
  } catch (error) {
    warnings.push(`Config validation failed: ${error.message}`);
  }

  const matchRatio = preview.scanned > 0 ? preview.posts.length / preview.scanned : 0;
  notes.push(`Parser preview: ${preview.posts.length} matched post(s) from ${preview.scanned} scanned message(s).`);
  if (preview.scanned > 0 && preview.posts.length === 0) {
    warnings.push('Parser matched nothing in recent messages. Filters may be too strict or paths may be wrong.');
  } else if (preview.scanned >= 10 && matchRatio < 0.1) {
    warnings.push('Parser matched less than 10% of recent messages. This can be fine for strict channels, but check rejected messages if selection looks empty.');
  } else if (preview.scanned >= 10 && matchRatio > 0.9) {
    warnings.push('Parser matched more than 90% of recent messages. This can be too broad if the source chat contains non-post messages.');
  }

  for (const template of templates) {
    if (template.source && !sourceKeys.has(template.source)) {
      warnings.push(`Template ${template.key || '<missing key>'} uses unknown source ${template.source}.`);
    }
  }

  for (const duplicate of findDuplicates(templates.map((template) => template.key).filter(Boolean))) {
    warnings.push(`Duplicate publish template key: ${duplicate}.`);
  }

  for (const conflict of findScheduleConflicts(templates)) {
    warnings.push(`Schedule conflict: ${conflict}.`);
  }

  const disabled = templates.filter((template) => template.enabled === false);
  if (disabled.length) {
    notes.push(`Disabled templates: ${disabled.map((template) => template.key).join(', ')}.`);
  }

  const firstSendAt = getEffectiveGlobalFirstSendAt(publish);
  if (firstSendAt) {
    notes.push(`First send gate is set to ${firstSendAt}. Runs before this timestamp are skipped unless forced.`);
  }

  if (!templates.length) warnings.push('No publish templates configured.');
  if (!sources.length) warnings.push('No publish sources configured.');

  return [
    'Setup doctor',
    '',
    warnings.length ? 'Warnings:' : 'Warnings: none.',
    ...warnings.map((warning) => `- ${warning}`),
    '',
    'Notes:',
    ...notes.map((note) => `- ${note}`),
    '',
    'Use Preview to inspect real output before saving.'
  ].join('\n');
}

function setupMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Doctor', 'setup:doctor')],
    [button('Preview', 'setup:preview'), button('Test parser', 'setup:test')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Advanced JSON', 'setup:advanced'), button('Show config', 'setup:config')],
    [button('Save', 'setup:save'), button('Cancel', 'setup:cancel')]
  ]);
}

function parserMenuKeyboard() {
  return inlineKeyboard([
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Advanced JSON', 'setup:advanced'), button('Status', 'setup:status')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function publishMenuKeyboard() {
  return inlineKeyboard([
    [button('Doctor', 'setup:doctor'), button('Preview', 'setup:preview')],
    [button('Advanced JSON', 'setup:advanced'), button('Show config', 'setup:config')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function previewMenuKeyboard() {
  return inlineKeyboard([
    [button('Looks good / Save', 'setup:save'), button('Run doctor', 'setup:doctor')],
    [button('Parser', 'setup:parser'), button('Publishing', 'setup:publish')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function advancedMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'setup:status'), button('Show config', 'setup:config')],
    [button('Test parser', 'setup:test'), button('Preview', 'setup:preview')],
    [button('Back to setup', 'setup:status')]
  ]);
}

function inlineKeyboard(inlineKeyboardRows) {
  return { reply_markup: { inline_keyboard: inlineKeyboardRows } };
}

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

function countRules(value) {
  return Array.isArray(value) ? value.length : 0;
}

function formatTemplateLines(templates, options = {}) {
  const visible = options.includeDisabled ? templates : templates.filter((template) => template.enabled !== false);
  if (!visible.length) return ['- none'];
  return visible.slice(0, 12).map((template) => {
    const status = template.enabled === false ? 'disabled' : 'enabled';
    const schedule = formatSchedule(template.schedule);
    const window = template.windowHours ? `, window=${template.windowHours}h` : '';
    return `- ${template.key || '<missing key>'}: ${status}, source=${template.source || '<missing source>'}, ${schedule}${window}`;
  });
}

function formatSchedule(schedule) {
  if (!schedule) return 'schedule=missing';
  if (schedule.type === 'daily') return `daily ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'weekly') return `weekly day ${schedule.weekday ?? '?'} ${schedule.time || '<missing time>'}`;
  if (schedule.type === 'monthly') return `monthly day ${schedule.dayOfMonth ?? '?'} ${schedule.time || '<missing time>'}`;
  return `${schedule.type || '<missing type>'} ${schedule.time || '<missing time>'}`;
}

function getEffectiveGlobalFirstSendAt(publish) {
  return publish?.firstSendAt ? String(publish.firstSendAt) : '';
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function findScheduleConflicts(templates) {
  const enabled = templates.filter((template) => template.enabled !== false && template.schedule);
  const groups = new Map();
  for (const template of enabled) {
    const key = scheduleIdentity(template.schedule);
    groups.set(key, [...(groups.get(key) || []), template.key || '<missing key>']);
  }
  return [...groups.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([schedule, keys]) => `${schedule} is used by ${keys.join(', ')}`);
}

function scheduleIdentity(schedule) {
  if (!schedule) return 'missing schedule';
  if (schedule.type === 'daily') return `daily:${schedule.time || ''}`;
  if (schedule.type === 'weekly') return `weekly:${schedule.weekday || ''}:${schedule.time || ''}`;
  if (schedule.type === 'monthly') return `monthly:${schedule.dayOfMonth || ''}:${schedule.time || ''}`;
  return `${schedule.type || ''}:${schedule.time || ''}`;
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function getArgument(text = '') {
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
