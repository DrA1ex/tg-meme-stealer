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

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  gray: '\u001b[90m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  magenta: '\u001b[35m',
  blue: '\u001b[34m',
  bold: '\u001b[1m'
};

const LEVEL_COLORS = {
  debug: ANSI.gray,
  info: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red
};

const STATUS_COLORS = {
  running: ANSI.blue,
  scheduled: ANSI.cyan,
  created: ANSI.cyan,
  published: ANSI.green,
  dry_run: ANSI.green,
  skipped: ANSI.yellow,
  exists: ANSI.yellow,
  duplicate: ANSI.yellow,
  busy: ANSI.yellow,
  failed: ANSI.red,
  error: ANSI.red
};

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
    debug: (message, fields) => writeLog(getSink(), getConfig(), 'debug', scope, message, fields),
    info: (message, fields) => writeLog(getSink(), getConfig(), 'info', scope, message, fields),
    warn: (message, fields) => writeLog(getSink(), getConfig(), 'warn', scope, message, fields),
    error: (message, fields) => writeLog(getSink(), getConfig(), 'error', scope, message, fields),
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

function writeLog(sink, config, level, scope, message, fields) {
  const minLevel = getMinLevel(config);
  if (LEVELS[level] < minLevel) return;
  const line = shouldColorLogs(config, sink)
    ? formatColoredLogLine({ level, scope, message, fields })
    : formatLogLine({ level, scope, message, fields });
  if (level === 'error') {
    sink.error(line);
  } else if (level === 'warn') {
    sink.warn(line);
  } else {
    sink.log(line);
  }
}

function shouldColorLogs(config, sink) {
  const mode = String(config?.logging?.color || 'auto').toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never' || process.env.NO_COLOR) return false;
  if (sink === console) return Boolean(process.stdout?.isTTY);
  return Boolean(sink?.isTTY);
}

function formatColoredLogLine({ level, scope, message, fields = {}, now = new Date() }) {
  const metadata = formatFields(fields, { color: true });
  const levelColor = LEVEL_COLORS[level] || '';
  const timestamp = colorize(now.toISOString(), ANSI.dim);
  const levelText = colorize(`[${level.toUpperCase()}]`, levelColor + ANSI.bold);
  const scopeText = colorize(`[${scope}]`, ANSI.cyan);
  const messageText = level === 'error'
    ? colorize(message, ANSI.red + ANSI.bold)
    : level === 'warn'
      ? colorize(message, ANSI.yellow)
      : message;
  return `${timestamp} ${levelText} ${scopeText} ${messageText}${metadata ? ` ${metadata}` : ''}`;
}

function formatFields(fields, options = {}) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => formatField(key, value, options))
    .join(' ');
}

function formatField(key, value, options = {}) {
  const renderedKey = options.color ? colorize(key, ANSI.dim) : key;
  const renderedValue = options.color ? colorizeFieldValue(key, value) : formatValue(value);
  return `${renderedKey}=${renderedValue}`;
}

function formatValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

function colorizeFieldValue(key, value) {
  const rendered = formatValue(value);
  if (value === null || value === undefined) return rendered;

  const normalizedKey = String(key).toLowerCase();
  const normalizedValue = String(value).toLowerCase();
  if (normalizedKey === 'error' || normalizedKey === 'lasterror') return colorize(rendered, ANSI.red);
  if (normalizedKey === 'reason') return colorize(rendered, ANSI.yellow);
  if (normalizedKey === 'status') return colorize(rendered, STATUS_COLORS[normalizedValue] || ANSI.bold);
  if (normalizedKey === 'key' || normalizedKey.endsWith('key')) return colorize(rendered, ANSI.magenta);
  if (normalizedKey.endsWith('id') || normalizedKey === 'messageid' || normalizedKey === 'publicationid') return colorize(rendered, ANSI.blue);
  return rendered;
}

function colorize(value, color) {
  if (!color) return value;
  return `${color}${value}${ANSI.reset}`;
}
