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
    this.configureCommands();
  }

  configureCommands() {
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== Number(this.config.telegram.adminId) || ctx.chat?.type !== 'private') return;
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
    await this.bot.launch();
  }

  async stopBot(signal = 'SIGTERM') {
    this.bot.stop(signal);
  }
}
