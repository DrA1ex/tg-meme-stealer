const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export function createLogger(config = {}, scope = 'app', sink = console) {
  const configuredLevel = config.logging?.level || 'info';
  const minLevel = LEVELS[configuredLevel] ?? LEVELS.info;

  return {
    debug: (message, fields) => writeLog(sink, minLevel, 'debug', scope, message, fields),
    info: (message, fields) => writeLog(sink, minLevel, 'info', scope, message, fields),
    warn: (message, fields) => writeLog(sink, minLevel, 'warn', scope, message, fields),
    error: (message, fields) => writeLog(sink, minLevel, 'error', scope, message, fields)
  };
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
