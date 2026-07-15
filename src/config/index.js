import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { compileSourceWhere, getSourceDefinitions } from '../core/sourceExpression.js';

dotenv.config();

const STRING = { type: 'string' };
const NUMBER = { type: 'number' };
const BOOLEAN = { type: 'boolean' };
const STRING_OR_NUMBER = { type: ['string', 'number'] };
const RULE_VALUE = { type: ['string', 'number', 'boolean'] };
const RULE_VALUES = { type: 'array', items: RULE_VALUE };

const RULE_SCHEMA = {
  source: STRING,
  path: STRING,
  regex: STRING,
  group: NUMBER,
  transform: STRING,
  aggregate: STRING,
  emojis: { type: 'array', items: STRING },
  emoji: STRING,
  invert: BOOLEAN,
  flags: STRING,
  value: { type: ['string', 'number', 'boolean', 'array'], items: RULE_VALUE },
  values: RULE_VALUES,
  contains: { type: ['string', 'number', 'boolean', 'array'], items: RULE_VALUE },
  equals: { type: ['string', 'number', 'boolean', 'array'], items: RULE_VALUE },
  in: { type: ['string', 'number', 'boolean', 'array'], items: RULE_VALUE },
  caseSensitive: BOOLEAN,
  negate: BOOLEAN,
  not: BOOLEAN
};

const SELECTION_SCHEMA = {
  source: STRING,
  key: STRING,
  enabled: BOOLEAN,
  schedule: {
    type: STRING,
    time: STRING,
    weekday: NUMBER,
    dayOfMonth: NUMBER
  },
  windowHours: NUMBER,
  offsetHours: NUMBER,
  posts: {
    target: NUMBER,
    min: NUMBER,
    max: NUMBER
  },
  reactions: {
    strategy: STRING,
    min: NUMBER,
    includeAbove: NUMBER
  },
  firstSendAt: STRING,
  template: STRING
};

const SOURCE_SCHEMA = {
  key: STRING,
  where: STRING
};

const CONFIG_SCHEMA = {
  telegram: {
    apiId: NUMBER,
    apiHash: STRING,
    sessionFile: STRING,
    sourceChatId: STRING_OR_NUMBER,
    adminId: NUMBER,
    publishChannelId: STRING_OR_NUMBER,
    botToken: STRING,
    pollingLockFile: STRING
  },
  database: {
    path: STRING
  },
  logging: {
    logLevel: STRING,
    color: STRING
  },
  shutdown: {
    timeoutMs: NUMBER
  },
  rateLimit: {
    mtprotoGroup: STRING,
    maxQueueDelayMs: NUMBER,
    longWaitWarnMs: NUMBER,
    telegramOperationTimeoutMs: NUMBER,
    redis: {
      enabled: BOOLEAN,
      mode: STRING,
      url: STRING,
      keyPrefix: STRING,
      connectTimeoutMs: NUMBER,
      operationTimeoutMs: NUMBER,
      circuitBreakMs: NUMBER,
      fallbackMultiplier: NUMBER,
      warningIntervalMs: NUMBER,
      keyTtlMs: NUMBER,
      penaltyTtlMs: NUMBER,
      penaltyQuietPeriodMs: NUMBER,
      penaltyDecayIntervalMs: NUMBER
    }
  },
  sync: {
    initialScanDays: NUMBER,
    refreshRecentDays: NUMBER,
    pageSize: NUMBER,
    maxPagesPerRun: NUMBER,
    mediaDir: STRING,
    intervalHours: NUMBER,
    runOnStart: BOOLEAN,
    retentionDays: NUMBER,
    retentionInitialDelayMinutes: NUMBER,
    retentionIntervalHours: NUMBER,
    maxRetries: NUMBER,
    retryBaseMs: NUMBER,
    retryMaxMs: NUMBER,
    maxMissingRatio: NUMBER,
    mediaMaxBytes: NUMBER,
    mediaMaxAgeHours: NUMBER,
    throttle: {
      enabled: BOOLEAN,
      historyMinMs: NUMBER,
      historyMaxMs: NUMBER,
      mediaMinMs: NUMBER,
      mediaMaxMs: NUMBER,
      reactionsMinMs: NUMBER,
      reactionsMaxMs: NUMBER,
      retryBufferMs: NUMBER
    }
  },
  parsing: {
    countLocale: STRING,
    fallbackReactions: {
      likeMarkers: { type: 'array', items: STRING },
      dislikeMarkers: { type: 'array', items: STRING }
    },
    filters: { type: 'array', items: RULE_SCHEMA },
    author: { type: 'array', items: RULE_SCHEMA },
    likes: { type: 'array', items: RULE_SCHEMA },
    dislikes: { type: 'array', items: RULE_SCHEMA }
  },
  publish: {
    dryRun: BOOLEAN,
    throttle: {
      enabled: BOOLEAN,
      perChatMinMs: NUMBER,
      globalMinMs: NUMBER,
      sharedDestinationMinMs: NUMBER,
      shareRetryAfterAcrossBots: BOOLEAN,
      retryBufferMs: NUMBER
    },
    requestTtlHours: NUMBER,
    workerLeaseMs: NUMBER,
    workerIntervalMinutes: NUMBER,
    postMaxRetries: NUMBER,
    maxConsecutivePostFailures: NUMBER,
    retryBaseMs: NUMBER,
    retryMaxMs: NUMBER,
    requestMaxRetries: NUMBER,
    firstSendAt: STRING,
    sources: { type: 'array', items: SOURCE_SCHEMA },
    template: { type: 'array', items: SELECTION_SCHEMA }
  },
  templates: {
    publish: {
      postCaption: STRING,
      unknownAuthor: STRING,
      maxTextLength: NUMBER
    },
    stats: {
      summary: STRING,
      topPost: STRING
    }
  },
  schedule: {
    enabled: BOOLEAN,
    timezone: STRING
  }
};

export function loadConfig() {
  const defaultPath = path.resolve('config.default.json');
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`Default config file not found: ${defaultPath}`);
  }

  const userConfigPath = path.resolve('config.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  const userConfig = fs.existsSync(userConfigPath)
    ? migrateOldPublishSelections(JSON.parse(fs.readFileSync(userConfigPath, 'utf8')))
    : {};
  const config = applyEnv(deepMerge(defaultConfig, userConfig), process.env);
  validateConfig(config, { pauseOnDuplicatePublishTemplates: true });
  return config;
}

export function migrateOldPublishSelections(config) {
  if (!config?.publish?.selections) return config;

  const migrated = structuredClone(config);
  const oldSelections = migrated.publish.selections;
  const currentTemplates = Array.isArray(migrated.publish.template) ? migrated.publish.template : [];
  migrated.publish.template = [
    ...currentTemplates,
    ...flattenPublishSelections(oldSelections)
  ];
  delete migrated.publish.selections;
  return migrated;
}

function flattenPublishSelections(selections) {
  const templates = [];
  for (const [source, sourceSelections] of Object.entries(selections || {})) {
    for (const [key, selection] of Object.entries(sourceSelections || {})) {
      templates.push({ source, key, ...selection });
    }
  }
  return templates;
}

export function applyEnv(config, env) {
  return deepMerge(config, {
    telegram: {
      apiId: numberFromEnv(env.TELEGRAM_API_ID),
      apiHash: env.TELEGRAM_API_HASH,
      sourceChatId: numberFromEnv(env.TELEGRAM_SOURCE_CHAT_ID),
      adminId: numberFromEnv(env.TELEGRAM_ADMIN_ID),
      publishChannelId: numberFromEnv(env.TELEGRAM_PUBLISH_CHANNEL_ID),
      botToken: env.TELEGRAM_BOT_TOKEN
    },
    rateLimit: {
      redis: {
        ...(env.RATE_LIMIT_REDIS_URL ? { url: env.RATE_LIMIT_REDIS_URL } : {}),
        ...(env.RATE_LIMIT_REDIS_ENABLED !== undefined
          ? { enabled: booleanFromEnv(env.RATE_LIMIT_REDIS_ENABLED) }
          : {})
      }
    }
  });
}

export function deepMerge(base, override, pathParts = []) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPublishTemplatePath(pathParts, key) && Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    if (isPublishSourcesPath(pathParts, key) && Array.isArray(value) && Array.isArray(base?.[key])) {
      result[key] = mergeKeyedObjects(base[key], value);
      continue;
    }
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      result[key] = deepMerge(base[key], value, [...pathParts, key]);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isPublishTemplatePath(pathParts, key) {
  return pathParts.length === 1 && pathParts[0] === 'publish' && key === 'template';
}

function isPublishSourcesPath(pathParts, key) {
  return pathParts.length === 1 && pathParts[0] === 'publish' && key === 'sources';
}

function mergeKeyedObjects(baseItems, overrideItems) {
  const result = baseItems.map((item) => ({ ...item }));
  const indexByKey = new Map(result.map((item, index) => [getPublishTemplateIdentity(item), index]));
  const overrideKeys = new Set();

  for (const override of overrideItems) {
    const key = getPublishTemplateIdentity(override);
    if (overrideKeys.has(key)) {
      result.push({ ...override });
      continue;
    }
    overrideKeys.add(key);

    if (indexByKey.has(key)) {
      const index = indexByKey.get(key);
      result[index] = deepMerge(result[index], override);
      continue;
    }
    indexByKey.set(key, result.length);
    result.push({ ...override });
  }

  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberFromEnv(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return value;
  return parsed;
}

function booleanFromEnv(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return value;
}

export function validateConfig(config, options = {}) {
  const schemaIssues = collectConfigIssues(config, CONFIG_SCHEMA);
  if (schemaIssues.length > 0) {
    throw new Error(`Invalid config:\n${schemaIssues.map((issue) => `- ${issue}`).join('\n')}`);
  }

  const required = [
    ['telegram', 'apiId'],
    ['telegram', 'apiHash'],
    ['telegram', 'sessionFile'],
    ['telegram', 'sourceChatId'],
    ['telegram', 'adminId'],
    ['telegram', 'publishChannelId'],
    ['telegram', 'botToken'],
    ['database', 'path']
  ];

  for (const [section, key] of required) {
    if (config?.[section]?.[key] === undefined || config[section][key] === '') {
      throw new Error(`Missing config value: ${section}.${key}`);
    }
  }

  if (String(config.telegram.sourceChatId) === String(config.telegram.publishChannelId)) {
    throw new Error('telegram.sourceChatId and telegram.publishChannelId must be different');
  }

  validateSharedRateLimitConfig(config);

  if (!(Number(config.shutdown?.timeoutMs ?? 30_000) > 0)) {
    throw new Error('shutdown.timeoutMs must be positive');
  }

  validateRuntimeSemantics(config);

  validatePublishTemplateDuplicates(config, options);
  validatePublishSourceDefinitions(config);
  validatePublishTemplates(config);
}

function validateSharedRateLimitConfig(config) {
  const redis = config.rateLimit?.redis;
  const maxQueueDelayMs = Number(config.rateLimit?.maxQueueDelayMs ?? 300_000);
  const longWaitWarnMs = Number(config.rateLimit?.longWaitWarnMs ?? 10_000);
  if (!(maxQueueDelayMs > 0) || !(longWaitWarnMs > 0) || longWaitWarnMs > maxQueueDelayMs) {
    throw new Error('rateLimit wait thresholds must be positive and longWaitWarnMs must not exceed maxQueueDelayMs');
  }
  if (!(Number(config.rateLimit?.telegramOperationTimeoutMs ?? 60_000) > 0)) {
    throw new Error('rateLimit.telegramOperationTimeoutMs must be positive');
  }
  if (!(Number(config.publish?.workerLeaseMs ?? 900_000) > maxQueueDelayMs)) {
    throw new Error('publish.workerLeaseMs must be greater than rateLimit.maxQueueDelayMs');
  }
  if (redis?.enabled !== true) return;
  if (redis.mode !== 'standalone') {
    throw new Error('rateLimit.redis.mode must be "standalone"; Redis Cluster is not supported');
  }
  if (!config.rateLimit?.mtprotoGroup || config.rateLimit.mtprotoGroup === 'local') {
    throw new Error('rateLimit.mtprotoGroup must be set explicitly when Redis rate limiting is enabled');
  }
  if (!redis.keyPrefix || redis.keyPrefix === 'tg-memes:local') {
    throw new Error('rateLimit.redis.keyPrefix must be set explicitly when Redis rate limiting is enabled');
  }
  if (!/^[a-zA-Z0-9:._-]+$/.test(config.rateLimit.mtprotoGroup)) {
    throw new Error('rateLimit.mtprotoGroup contains unsupported characters');
  }
  if (!/^[a-zA-Z0-9:._-]+$/.test(redis.keyPrefix)) {
    throw new Error('rateLimit.redis.keyPrefix contains unsupported characters');
  }
  if (!/^\d+:.+/.test(String(config.telegram.botToken))) {
    throw new Error('telegram.botToken must start with the numeric bot id when Redis rate limiting is enabled');
  }
  if (!(Number(redis.fallbackMultiplier) >= 1)) {
    throw new Error('rateLimit.redis.fallbackMultiplier must be at least 1');
  }
}

function validatePublishTemplateDuplicates(config, options = {}) {
  const templates = config?.publish?.template || [];
  const counts = new Map();
  for (const template of templates) {
    const key = template?.key || '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => `${key} (${count})`);
  if (duplicates.length === 0) return;

  throw new Error(`Duplicate publish templates:\n${duplicates.map((duplicate) => `- ${duplicate}`).join('\n')}`);
}

function getPublishTemplateIdentity(template) {
  return `${template?.key || ''}`;
}

function validatePublishSourceDefinitions(config) {
  const sources = config?.publish?.sources || [];
  const issues = [];
  const counts = new Map();

  for (const [index, source] of sources.entries()) {
    const pathPrefix = `publish.sources.${index}`;
    if (!source.key) {
      issues.push(`${pathPrefix}.key: expected non-empty string`);
    }
    counts.set(source.key || '', (counts.get(source.key || '') || 0) + 1);
    try {
      compileSourceWhere(source.where || 'true');
    } catch (error) {
      issues.push(`${pathPrefix}.where: invalid expression (${error.message})`);
    }
  }

  for (const [key, count] of counts.entries()) {
    if (key && count > 1) issues.push(`publish.sources: duplicate source key ${key} (${count})`);
  }

  if (issues.length > 0) {
    throw new Error(`Invalid config:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
}

function validatePublishTemplates(config) {
  const templates = config?.publish?.template || [];
  const issues = [];
  const sourceKeys = new Set(getSourceDefinitions(config).map((source) => source.key));
  if (config?.publish?.firstSendAt !== undefined && Number.isNaN(Date.parse(config.publish.firstSendAt))) {
    issues.push('publish.firstSendAt: expected valid date string');
  }

  for (const [index, template] of templates.entries()) {
    const pathPrefix = `publish.template.${index}`;
    if (!template.key) {
      issues.push(`${pathPrefix}.key: expected non-empty string`);
    }
    if (!sourceKeys.has(template.source)) {
      issues.push(`${pathPrefix}.source: unknown publish source`);
    }

    if (!isPositiveNumber(template.windowHours)) {
      issues.push(`${pathPrefix}.windowHours: expected number greater than 0`);
    }
    if (template.offsetHours !== undefined && !isNonNegativeNumber(template.offsetHours)) {
      issues.push(`${pathPrefix}.offsetHours: expected number greater than or equal to 0`);
    }

    const posts = template.posts || {};
    if (!isNonNegativeInteger(posts.min)) {
      issues.push(`${pathPrefix}.posts.min: expected non-negative integer`);
    }
    if (!isNonNegativeInteger(posts.target)) {
      issues.push(`${pathPrefix}.posts.target: expected non-negative integer`);
    }
    if (!isNonNegativeInteger(posts.max)) {
      issues.push(`${pathPrefix}.posts.max: expected non-negative integer`);
    }
    if (isFiniteNumber(posts.min) && isFiniteNumber(posts.target) && isFiniteNumber(posts.max) && (posts.min > posts.target || posts.target > posts.max)) {
      issues.push(`${pathPrefix}.posts: expected min <= target <= max`);
    }

    const strategy = template.reactions?.strategy;
    if (strategy !== undefined && !['likes', 'dislikes', 'sum', 'max'].includes(strategy)) {
      issues.push(`${pathPrefix}.reactions.strategy: expected likes, dislikes, sum, or max`);
    }
    if (!isFiniteNumber(template.reactions?.min)) {
      issues.push(`${pathPrefix}.reactions.min: expected number`);
    }
    if (!isFiniteNumber(template.reactions?.includeAbove)) {
      issues.push(`${pathPrefix}.reactions.includeAbove: expected number`);
    }

    if (template.enabled) {
      issues.push(...validateSchedule(template.schedule, `${pathPrefix}.schedule`));
    }
    if (template.firstSendAt !== undefined && Number.isNaN(Date.parse(template.firstSendAt))) {
      issues.push(`${pathPrefix}.firstSendAt: expected valid date string`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid config:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
}

function validateSchedule(schedule, pathPrefix) {
  const issues = [];
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return [`${pathPrefix}: expected object`];
  }
  if (!['daily', 'weekly', 'monthly'].includes(schedule.type)) {
    issues.push(`${pathPrefix}.type: expected daily, weekly, or monthly`);
  }
  if (!isValidTime(schedule.time)) {
    issues.push(`${pathPrefix}.time: expected HH:mm`);
  }
  if (schedule.type === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 1 || schedule.weekday > 7)) {
    issues.push(`${pathPrefix}.weekday: expected integer from 1 to 7`);
  }
  if (schedule.type === 'monthly' && (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 28)) {
    issues.push(`${pathPrefix}.dayOfMonth: expected integer from 1 to 28`);
  }
  return issues;
}

function isValidTime(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function validateRuntimeSemantics(config) {
  const issues = [];
  const positive = [
    ['sync.initialScanDays', config.sync?.initialScanDays],
    ['sync.refreshRecentDays', config.sync?.refreshRecentDays],
    ['sync.pageSize', config.sync?.pageSize],
    ['sync.maxPagesPerRun', config.sync?.maxPagesPerRun],
    ['sync.intervalHours', config.sync?.intervalHours],
    ['sync.retentionDays', config.sync?.retentionDays],
    ['sync.retentionIntervalHours', config.sync?.retentionIntervalHours],
    ['sync.retryBaseMs', config.sync?.retryBaseMs],
    ['sync.retryMaxMs', config.sync?.retryMaxMs],
    ['sync.mediaMaxBytes', config.sync?.mediaMaxBytes],
    ['sync.mediaMaxAgeHours', config.sync?.mediaMaxAgeHours],
    ['publish.requestTtlHours', config.publish?.requestTtlHours],
    ['publish.workerLeaseMs', config.publish?.workerLeaseMs],
    ['publish.workerIntervalMinutes', config.publish?.workerIntervalMinutes],
    ['publish.retryBaseMs', config.publish?.retryBaseMs],
    ['publish.retryMaxMs', config.publish?.retryMaxMs]
  ];
  for (const [name, value] of positive) {
    if (value !== undefined && !isPositiveNumber(value)) issues.push(`${name}: expected number greater than 0`);
  }

  const nonNegativeIntegers = [
    ['sync.maxRetries', config.sync?.maxRetries],
    ['publish.postMaxRetries', config.publish?.postMaxRetries],
    ['publish.maxConsecutivePostFailures', config.publish?.maxConsecutivePostFailures],
    ['publish.requestMaxRetries', config.publish?.requestMaxRetries]
  ];
  for (const [name, value] of nonNegativeIntegers) {
    if (value !== undefined && !isNonNegativeInteger(value)) issues.push(`${name}: expected non-negative integer`);
  }

  if (config.sync?.maxMissingRatio !== undefined && (!isFiniteNumber(config.sync.maxMissingRatio) || config.sync.maxMissingRatio < 0 || config.sync.maxMissingRatio > 1)) {
    issues.push('sync.maxMissingRatio: expected number from 0 to 1');
  }
  if (config.sync?.retryMaxMs !== undefined && config.sync?.retryBaseMs !== undefined && config.sync.retryMaxMs < config.sync.retryBaseMs) issues.push('sync.retryMaxMs must be greater than or equal to sync.retryBaseMs');
  if (config.publish?.retryMaxMs !== undefined && config.publish?.retryBaseMs !== undefined && config.publish.retryMaxMs < config.publish.retryBaseMs) issues.push('publish.retryMaxMs must be greater than or equal to publish.retryBaseMs');
  if (config.sync?.retentionInitialDelayMinutes !== undefined && !isNonNegativeNumber(config.sync.retentionInitialDelayMinutes)) issues.push('sync.retentionInitialDelayMinutes: expected number greater than or equal to 0');

  for (const [name, min, max] of [
    ['sync.throttle.history', config.sync?.throttle?.historyMinMs, config.sync?.throttle?.historyMaxMs],
    ['sync.throttle.media', config.sync?.throttle?.mediaMinMs, config.sync?.throttle?.mediaMaxMs],
    ['sync.throttle.reactions', config.sync?.throttle?.reactionsMinMs, config.sync?.throttle?.reactionsMaxMs]
  ]) {
    if (min === undefined && max === undefined) continue;
    if (!isNonNegativeNumber(min) || !isNonNegativeNumber(max) || min > max) issues.push(`${name}: expected non-negative min <= max`);
  }

  if (config.schedule?.timezone !== undefined && !isValidTimezone(config.schedule.timezone)) issues.push('schedule.timezone: expected valid IANA timezone');
  if (config.parsing?.countLocale !== undefined && !isValidLocale(config.parsing.countLocale)) issues.push('parsing.countLocale: expected valid locale');
  if (config.parsing?.fallbackReactions?.likeMarkers !== undefined && (!Array.isArray(config.parsing.fallbackReactions.likeMarkers) || config.parsing.fallbackReactions.likeMarkers.some((value) => !String(value)))) {
    issues.push('parsing.fallbackReactions.likeMarkers: expected non-empty strings');
  }
  if (config.parsing?.fallbackReactions?.dislikeMarkers !== undefined && (!Array.isArray(config.parsing.fallbackReactions.dislikeMarkers) || config.parsing.fallbackReactions.dislikeMarkers.some((value) => !String(value)))) {
    issues.push('parsing.fallbackReactions.dislikeMarkers: expected non-empty strings');
  }
  if (!isPositiveInteger(config.templates?.publish?.maxTextLength) || config.templates.publish.maxTextLength > 4096) {
    issues.push('templates.publish.maxTextLength: expected integer from 1 to 4096');
  }
  if (String(config.templates?.publish?.postCaption || '').length > 4096) issues.push('templates.publish.postCaption: template must not exceed 4096 characters');
  if (String(config.templates?.stats?.summary || '').length > 4096) issues.push('templates.stats.summary: template must not exceed 4096 characters');
  if (String(config.templates?.stats?.topPost || '').length > 4096) issues.push('templates.stats.topPost: template must not exceed 4096 characters');

  if (issues.length) throw new Error(`Invalid config:
${issues.map((issue) => `- ${issue}`).join('\n')}`);
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(locale) {
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length === 1;
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function collectConfigIssues(value, schema, pathParts = []) {
  if (value === undefined) return [];

  if (isTypeSchema(schema)) {
    return collectTypeIssues(value, schema, pathParts);
  }

  if (value === null || !isPlainObject(value)) {
    return [`${formatPath(pathParts)}: expected object`];
  }

  const issues = [];
  for (const [key, child] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      issues.push(`${formatPath([...pathParts, key])}: unsupported option`);
      continue;
    }
    issues.push(...collectConfigIssues(child, schema[key], [...pathParts, key]));
  }
  return issues;
}

function isTypeSchema(schema) {
  return isPlainObject(schema)
    && Object.prototype.hasOwnProperty.call(schema, 'type')
    && (typeof schema.type === 'string' || Array.isArray(schema.type));
}

function collectTypeIssues(value, schema, pathParts) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) {
    return [`${formatPath(pathParts)}: expected ${formatExpectedTypes(types)}, got ${describeType(value)}`];
  }

  if (Array.isArray(value) && schema.items) {
    const issues = [];
    for (const [index, item] of value.entries()) {
      issues.push(...collectConfigIssues(item, schema.items, [...pathParts, String(index)]));
    }
    return issues;
  }

  return [];
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function formatExpectedTypes(types) {
  return types.join(' or ');
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatPath(pathParts) {
  return pathParts.length > 0 ? pathParts.join('.') : '<root>';
}
