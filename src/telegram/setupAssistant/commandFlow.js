import {
  addParsingRule,
  formatPreviewPost,
  parseJsonArgument,
  selectWeekPreviewPosts,
  setPublishSources,
  setPublishTemplate,
  upsertPublishSource,
  setParsingRules,
  setTemplateValue,
  summarizeParsedPosts,
  sendRichPost,
  DEFAULT_TEST_MESSAGES,
  formatParserChanges,
  formatPublishChanges,
  parseSourceTextCommand,
  parserMenuKeyboard,
  previewMenuKeyboard,
  publishMenuKeyboard,
  sourcesKeyboard,
  setupMenuKeyboard,
  getArgument,
  parseLimit,
  parseMessageId,
  parsePreviewArgs,
  replyCode,
  replyJsonCode,
  replyJsonFile,
  splitFirstArgument
} from './deps.js';
import {
  formatPreviewProgress
} from './helpers.js';

export async function setRules(ctx, key) {
  const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
  const rules = parseJsonArgument(ctx.message.text);
  setParsingRules(this.getDraft(ctx), key, rules);
  this.markChanged(ctx, 'parser', `${key} replaced`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
  await this.replyWithKeyboard(ctx, `${key} replaced. Use Test content or Preview to check the result.`, parserMenuKeyboard());
}

export async function addRules(ctx, key) {
  const beforeParsing = structuredClone(this.getDraft(ctx).parsing || {});
  const rules = parseJsonArgument(ctx.message.text);
  addParsingRule(this.getDraft(ctx), key, rules);
  this.markChanged(ctx, 'parser', `${key} appended`, formatParserChanges(beforeParsing, this.getDraft(ctx).parsing || {}, { compact: false }));
  await this.replyWithKeyboard(ctx, `${key} appended. Use Test content or Preview to check the result.`, parserMenuKeyboard());
}

export async function setTemplate(ctx) {
  const [key, value] = splitFirstArgument(ctx.message.text);
  if (!key || !value) throw new Error('Usage: /settemplate <key> <value>');
  setTemplateValue(this.getDraft(ctx), key, value);
  this.markChanged(ctx, 'templates', `${key} template updated`, [`- ${key}`]);
  await this.replyWithKeyboard(ctx, `${key} template updated. Use Preview to check the result.`, setupMenuKeyboard());
}

export async function setSources(ctx) {
  const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
  const sources = parseJsonArgument(ctx.message.text);
  setPublishSources(this.getDraft(ctx), sources);
  this.markChanged(ctx, 'publishing', 'publish.sources replaced', formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
  await this.replyWithKeyboard(ctx, 'publish.sources replaced. Run Doctor or Save when ready.', publishMenuKeyboard());
}

export async function setSource(ctx) {
  const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
  let source;
  try {
    source = parseSourceTextCommand(ctx.message.text);
  } catch (error) {
    await this.sourceCustomHelp(ctx, error.message);
    return;
  }
  upsertPublishSource(this.getDraft(ctx), source);
  this.markChanged(ctx, 'publishing', `publish.sources.${source.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
  await this.replyWithKeyboard(ctx, `publish.sources.${source.key} updated. Run Source test or Save when ready.`, sourcesKeyboard(this.getDraft(ctx)));
}

export async function setPublish(ctx) {
  const beforePublish = structuredClone(this.getDraft(ctx).publish || {});
  const template = parseJsonArgument(ctx.message.text);
  setPublishTemplate(this.getDraft(ctx), template);
  this.markChanged(ctx, 'publishing', `publish.template.${template.key} updated`, formatPublishChanges(beforePublish, this.getDraft(ctx).publish || {}));
  await this.replyWithKeyboard(ctx, `publish.template.${template.key} updated. Run Doctor or Save when ready.`, publishMenuKeyboard());
}

export async function test(ctx) {
  const hasExplicitLimit = Boolean(getArgument(ctx.message.text));
  const result = hasExplicitLimit
                 ? await this.scanner.previewRecent(parseLimit(ctx.message.text, DEFAULT_TEST_MESSAGES), this.getDraft(ctx))
                 : await this.collectSetupSample(ctx, { purpose: 'parser test' });
  await replyCode(ctx, summarizeParsedPosts(result));
  this.markTested(ctx);
}

export async function raw(ctx) {
  const messageId = parseMessageId(ctx.message.text);
  const message = await this.scanner.getMessageById(messageId);
  if (!message) {
    await ctx.reply(`Message not found: ${messageId}`);
    return;
  }
  await replyJsonFile(ctx, message, `telegram-message-${messageId}.json`);
}

export async function testMessage(ctx) {
  const messageId = parseMessageId(ctx.message.text);
  const result = await this.scanner.previewMessage(messageId, this.getDraft(ctx));
  if (!result.message) {
    await ctx.reply(`Message not found: ${messageId}`);
    return;
  }
  await replyCode(ctx, summarizeParsedPosts({ scanned: 1, posts: result.posts }));
  if (!result.posts.length) {
    await this.replyWithKeyboard(ctx, 'Message did not match the current parser rules.', parserMenuKeyboard());
    return;
  }
  await replyJsonCode(ctx, result.posts.length === 1 ? result.posts[0] : result.posts);
}

export async function debug(ctx) {
  const messageId = parseMessageId(ctx.message.text);
  const result = await this.scanner.debugMessage(messageId, this.getDraft(ctx));
  if (!result.message) {
    await ctx.reply(`Message not found: ${messageId}`);
    return;
  }
  await replyJsonFile(ctx, result.debug, `telegram-message-${messageId}-debug.json`);
}

export async function preview(ctx) {
  const args = parsePreviewArgs(ctx.message.text);
  await this.sendPreview(ctx, args);
}

export async function sendPreview(ctx, { postCount, messageCount }) {
  const result = await this.scanner.previewRecent(messageCount, this.getDraft(ctx));
  const posts = selectWeekPreviewPosts(result.posts, postCount);
  const draft = this.getDraft(ctx);
  this.markPreviewed(ctx);
  await this.replyWithKeyboard(ctx, [
    `Preview source: ${result.posts.length} matched posts from ${result.scanned} scanned messages.`,
    `Showing ${posts.length} selected post(s).`,
    '',
    'If the match set is wrong, use Content setup → Quick setup or Advanced JSON.'
  ].join('\n'), previewMenuKeyboard());

  if (!posts.length) {
    await this.replyWithKeyboard(ctx, formatPreviewPost(null, draft.templates), previewMenuKeyboard());
    return;
  }

  const progress = await ctx.reply(formatPreviewProgress({ total: posts.length, sent: 0 }));
  try {
    for (let index = 0; index < posts.length; index += 1) {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, formatPreviewProgress({
        total: posts.length,
        sent: index,
        current: index + 1
      })).catch(() => {});
      await sendRichPost({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        mediaDownloader: this.mediaDownloader,
        post: posts[index],
        index,
        templates: draft.templates
      });
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, formatPreviewProgress({
        total: posts.length,
        sent: index + 1
      })).catch(() => {});
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, progress.message_id).catch(async () => {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `✅ Preview sent: ${posts.length} post(s).`).catch(() => {});
    });
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `⚠️ Preview stopped after sending some posts: ${error.message}`).catch(() => {});
    throw error;
  }
}

export const commandFlowMethods = {
  setRules,
  addRules,
  setTemplate,
  setSources,
  setSource,
  setPublish,
  test,
  raw,
  testMessage,
  debug,
  preview,
  sendPreview
};
