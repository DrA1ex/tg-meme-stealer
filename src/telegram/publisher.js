import { Telegraf } from 'telegraf';
import { formatPostCaption, formatSelectionHeader } from '../core/format.js';
import { loadSelections } from '../core/selection.js';
import { buildStats, formatStats } from '../core/stats.js';

export class SelectionPublisher {
  constructor({ repository, mediaDownloader, setupAssistant, config }) {
    this.repository = repository;
    this.mediaDownloader = mediaDownloader;
    this.setupAssistant = setupAssistant;
    this.config = config;
    this.bot = new Telegraf(config.telegram.botToken);
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
    for (const selection of selections) {
      await this.publishSelection(selection);
    }
    return selections.map((selection) => ({ key: selection.key, count: selection.posts.length }));
  }

  async publishSelection(selection) {
    if (selection.posts.length === 0) return;

    if (this.config.publish.dryRun) {
      console.log(`[dry-run] ${selection.title}: ${selection.posts.length} posts`);
      await this.recordPublication(selection, 'dry_run');
      return;
    }

    await this.bot.telegram.sendMessage(this.config.telegram.publishChannelId, formatSelectionHeader(selection.title));

    for (let index = 0; index < selection.posts.length; index += 1) {
      await this.publishPost(selection.posts[index], index);
    }
    await this.recordPublication(selection, 'published');
  }

  async publishPost(post, index) {
    const files = await this.mediaDownloader.downloadPostMedia(post);
    const caption = formatPostCaption(post, index, this.config.templates);

    if (files.length === 0) {
      await this.bot.telegram.sendMessage(this.config.telegram.publishChannelId, caption);
      return;
    }

    if (files.length === 1) {
      const file = files[0];
      if (file.kind === 'video') {
        await this.bot.telegram.sendVideo(this.config.telegram.publishChannelId, { source: file.path }, { caption });
      } else {
        await this.bot.telegram.sendPhoto(this.config.telegram.publishChannelId, { source: file.path }, { caption });
      }
      return;
    }

    await this.bot.telegram.sendMediaGroup(
      this.config.telegram.publishChannelId,
      files.map((file, fileIndex) => ({
        type: file.kind === 'video' ? 'video' : 'photo',
        media: { source: file.path },
        caption: fileIndex === 0 ? caption : undefined
      }))
    );
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
