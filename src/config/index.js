import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

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
  time: STRING,
  limit: NUMBER,
  windowHours: NUMBER,
  threshold: NUMBER,
  template: STRING
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
    ? migrateUserConfigIfNeeded(userConfigPath)
    : {};
  const config = applyEnv(deepMerge(defaultConfig, userConfig), process.env);
  validateConfig(config, { pauseOnDuplicatePublishTemplates: true });
  return config;
}

function migrateUserConfigIfNeeded(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const migrated = migrateOldPublishSelections(config);
  if (migrated === config) return config;

  const backupPath = `${configPath}.old`;
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, `${JSON.stringify(migrated, null, 2)}\n`);
  return migrated;
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

function mergePublishTemplates(baseTemplates, overrideTemplates) {
  const result = baseTemplates.map((template) => ({ ...template }));
  const indexByKey = new Map(result.map((template, index) => [getPublishTemplateIdentity(template), index]));
  const overrideKeys = new Set();

  for (const override of overrideTemplates) {
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
}

function validatePublishTemplateDuplicates(config, options = {}) {
  const templates = config?.publish?.template || [];
  const counts = new Map();
  for (const template of templates) {
    const key = getPublishTemplateIdentity(template);
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
  return `${template?.source || ''}.${template?.key || ''}`;
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
  return isPlainObject(schema) && Object.prototype.hasOwnProperty.call(schema, 'type');
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
