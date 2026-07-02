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
    botToken: STRING
  },
  database: {
    path: STRING
  },
  logging: {
    logLevel: STRING,
    color: STRING
  },
  sync: {
    initialScanDays: NUMBER,
    refreshRecentDays: NUMBER,
    pageSize: NUMBER,
    mediaDir: STRING,
    intervalHours: NUMBER,
    runOnStart: BOOLEAN,
    retentionDays: NUMBER,
    retentionInitialDelayMinutes: NUMBER,
    retentionIntervalHours: NUMBER,
    throttle: {
      enabled: BOOLEAN,
      historyMinMs: NUMBER,
      historyMaxMs: NUMBER,
      mediaMinMs: NUMBER,
      mediaMaxMs: NUMBER
    }
  },
  parsing: {
    filters: { type: 'array', items: RULE_SCHEMA },
    author: { type: 'array', items: RULE_SCHEMA },
    likes: { type: 'array', items: RULE_SCHEMA },
    dislikes: { type: 'array', items: RULE_SCHEMA }
  },
  publish: {
    dryRun: BOOLEAN,
    requestTtlHours: NUMBER,
    workerIntervalMinutes: NUMBER,
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
    ? JSON.parse(fs.readFileSync(userConfigPath, 'utf8'))
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
    }
  });
}

export function deepMerge(base, override, pathParts = []) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPublishTemplatePath(pathParts, key) && Array.isArray(value) && Array.isArray(base?.[key])) {
      result[key] = mergePublishTemplates(base[key], value);
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

function mergePublishTemplates(baseTemplates, overrideTemplates) {
  return mergeKeyedObjects(baseTemplates, overrideTemplates);
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

  validatePublishTemplateDuplicates(config, options);
  validatePublishSourceDefinitions(config);
  validatePublishTemplates(config);
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

  if (options.pauseOnDuplicatePublishTemplates) sleepSync(5000);
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

    const posts = template.posts || {};
    if (!isFiniteNumber(posts.min)) {
      issues.push(`${pathPrefix}.posts.min: expected number`);
    }
    if (!isFiniteNumber(posts.target)) {
      issues.push(`${pathPrefix}.posts.target: expected number`);
    }
    if (!isFiniteNumber(posts.max)) {
      issues.push(`${pathPrefix}.posts.max: expected number`);
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

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
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
