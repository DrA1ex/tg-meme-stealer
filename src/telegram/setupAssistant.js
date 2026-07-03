import { loadConfig } from './setupAssistant/deps.js';
import { routingMethods } from './setupAssistant/routing.js';
import { sessionMethods } from './setupAssistant/session.js';
import { technicalFlowMethods } from './setupAssistant/technicalFlow.js';
import { parserFlowMethods } from './setupAssistant/parserFlow.js';
import { publishFlowMethods } from './setupAssistant/publishFlow.js';
import { sampleFlowMethods } from './setupAssistant/sampleFlow.js';
import { commandFlowMethods } from './setupAssistant/commandFlow.js';

export class SetupAssistant {
  constructor({ scanner, mediaDownloader, config, configLoader = loadConfig }) {
    this.scanner = scanner;
    this.mediaDownloader = mediaDownloader;
    this.config = config;
    this.configLoader = configLoader;
    this.sessions = new Map();
    this.setupMessages = new Map();
    this.setupSuggestions = new Map();
    this.setupMeta = new Map();
    this.setupLastChange = new Map();
    this.setupTrafficPresets = new Map();
    this.setupSampleCache = new Map();
    this.setupCurrentView = new Map();
    this.setupScheduleWizards = new Map();
    this.setupTextPrompts = new Map();
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
    bot.on('text', (ctx) => this.handleSetupText(ctx));
  }
}

Object.assign(
  SetupAssistant.prototype,
  routingMethods,
  sessionMethods,
  technicalFlowMethods,
  parserFlowMethods,
  publishFlowMethods,
  sampleFlowMethods,
  commandFlowMethods
);

export { stringifyForSetup } from './setup/utils.js';
