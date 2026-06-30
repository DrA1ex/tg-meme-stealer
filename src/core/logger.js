const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

let globalConfig = { logging: { logLevel: 'INFO' } };
let globalSink = console;

export const logger = getLogger('app');

export function configureLogger(config = {}, sink = console) {
  globalConfig = config || {};
  globalSink = sink || console;
}

export function getLogger(scope = 'app') {
  return createScopedLogger({
    scope,
    getConfig: () => globalConfig,
    getSink: () => globalSink
  });
}

export function createLogger(config = {}, scope = 'app', sink = console) {
  return createScopedLogger({
    scope,
    getConfig: () => config,
    getSink: () => sink
  });
}

function createScopedLogger({ scope, getConfig, getSink }) {
  return {
    debug: (message, fields) => writeLog(getSink(), getMinLevel(getConfig()), 'debug', scope, message, fields),
    info: (message, fields) => writeLog(getSink(), getMinLevel(getConfig()), 'info', scope, message, fields),
    warn: (message, fields) => writeLog(getSink(), getMinLevel(getConfig()), 'warn', scope, message, fields),
    error: (message, fields) => writeLog(getSink(), getMinLevel(getConfig()), 'error', scope, message, fields),
    child: (childScope) => createScopedLogger({ scope: childScope, getConfig, getSink })
  };
}

function getMinLevel(config) {
  const configuredLevel = String(config?.logging?.logLevel || 'INFO').toLowerCase();
  return LEVELS[configuredLevel] ?? LEVELS.info;
}

export function formatLogLine({ level, scope, message, fields = {}, now = new Date() }) {
  const metadata = formatFields(fields);
  return `${now.toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${metadata ? ` ${metadata}` : ''}`;
}

function writeLog(sink, minLevel, level, scope, message, fields) {
  if (LEVELS[level] < minLevel) return;
  const line = formatLogLine({ level, scope, message, fields });
  if (level === 'error') {
    sink.error(line);
  } else if (level === 'warn') {
    sink.warn(line);
  } else {
    sink.log(line);
  }
}

function formatFields(fields) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
}

function formatValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}
