import { Telegraf } from 'telegraf';
import { formatSelectionHeader } from '../core/format.js';
import { createLogger } from '../core/logger.js';
import { loadSelections } from '../core/selection.js';
import { buildStats, formatStats } from '../core/stats.js';
import { withBotApiRetry } from './retry.js';
import { sendRichPost } from './richPost.js';

export class SelectionPublisher {
  constructor({ repository, mediaDownloader, setupAssistant, config }) {
    this.repository = repository;
    this.mediaDownloader = mediaDownloader;
    this.setupAssistant = setupAssistant;
    this.config = config;
    this.bot = new Telegraf(config.telegram.botToken);
    this.logger = createLogger(config, 'publisher');
    this.activeHandlers = 0;
    this.idleResolvers = [];
    this.configureCommands();
  }

  configureCommands() {
    this.bot.use(async (ctx, next) => {
      this.activeHandlers += 1;
      try {
        await next();
      } finally {
        this.activeHandlers -= 1;
        this.resolveIdle();
      }
    });

    this.bot.use(async (ctx, next) => {
      const command = getCommandName(ctx);
      if (ctx.from?.id !== Number(this.config.telegram.adminId) || ctx.chat?.type !== 'private') {
        if (command) {
          this.logger.warn('Bot command ignored', {
            command,
            fromId: ctx.from?.id,
            chatId: ctx.chat?.id,
            chatType: ctx.chat?.type
          });
        }
        return;
      }
      if (command) {
        this.logger.info('Bot command received', {
          command,
          fromId: ctx.from?.id,
          chatId: ctx.chat?.id
        });
      }
      await next();
    });

    this.bot.start((ctx) => ctx.reply('Available commands: /stats, /setup'));
    this.bot.command('stats', async (ctx) => {
      const stats = await buildStats(this.repository, this.config);
      await ctx.reply(formatStats(stats, this.config.templates));
    });
    this.setupAssistant?.register(this.bot);
  }

  async publishAll(now = new Date(), keys = null) {
    const selections = await loadSelections(this.repository, this.config, now, keys);
    this.logger.info('Publish cycle started', {
      targetChatId: this.config.telegram.publishChannelId,
      keys: keys || 'all',
      selections: selections.length
    });
    for (const selection of selections) {
      await this.publishSelection(selection);
    }
    return selections.map((selection) => ({ key: selection.key, count: selection.posts.length }));
  }

  async publishSelection(selection) {
    if (selection.posts.length === 0) {
      this.logger.info('Selection skipped: no posts', { selection: selection.key });
      return;
    }

    if (this.config.publish.dryRun) {
      this.logger.info('Selection dry-run', {
        selection: selection.key,
        title: selection.title,
        posts: selection.posts.length,
        targetChatId: this.config.telegram.publishChannelId
      });
      await this.recordPublication(selection, 'dry_run');
      return;
    }

    this.logger.info('Publishing selection header', {
      selection: selection.key,
      title: selection.title,
      posts: selection.posts.length,
      targetChatId: this.config.telegram.publishChannelId
    });
    await withBotApiRetry(
      () => this.bot.telegram.sendMessage(this.config.telegram.publishChannelId, formatSelectionHeader(selection.title)),
      { label: 'sendSelectionHeader' }
    );

    for (let index = 0; index < selection.posts.length; index += 1) {
      await this.publishPost(selection.posts[index], index);
    }
    await this.recordPublication(selection, 'published');
  }

  async publishPost(post, index) {
    this.logger.info('Publishing post', {
      targetChatId: this.config.telegram.publishChannelId,
      sourceChatId: post.chatId,
      messageId: post.messageId,
      position: index + 1
    });
    await sendRichPost({
      telegram: this.bot.telegram,
      chatId: this.config.telegram.publishChannelId,
      mediaDownloader: this.mediaDownloader,
      post,
      index,
      templates: this.config.templates
    });
  }

  async recordPublication(selection, status) {
    await this.repository.createPublication({
      selectionKey: selection.key,
      title: selection.title,
      periodStart: selection.sinceIso,
      periodEnd: selection.untilIso,
      status,
      posts: selection.posts,
      data: { count: selection.posts.length }
    });
  }

  async launchBot() {
    this.logger.info('Launching bot polling', {
      adminId: this.config.telegram.adminId,
      publishChannelId: this.config.telegram.publishChannelId
    });
    await this.bot.launch();
    this.logger.info('Bot polling started');
  }

  async stopBot(signal = 'SIGTERM') {
    this.logger.info('Stopping bot polling', { signal });
    try {
      this.bot.stop(signal);
    } catch (error) {
      if (!isBotAlreadyStoppedError(error)) throw error;
    }
    await this.waitForIdle();
    this.logger.info('Bot polling stopped');
  }

  async waitForIdle(timeoutMs = 30000) {
    if (this.activeHandlers === 0) return;

    const idle = new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([idle, timeout]);
    if (result === 'timeout') {
      this.logger.warn('Timed out waiting for active bot handlers', { activeHandlers: this.activeHandlers, timeoutMs });
    }
  }

  resolveIdle() {
    if (this.activeHandlers !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}

function isBotAlreadyStoppedError(error) {
  return /not running|not started/i.test(String(error?.message || error));
}

function getCommandName(ctx) {
  const text = ctx.message?.text || ctx.update?.message?.text || '';
  const match = text.match(/^\/([^\s@]+)(?:@\w+)?/);
  return match?.[1] || '';
}
