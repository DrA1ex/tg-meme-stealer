const ALLOWED_IDENTIFIERS = new Set(['likes', 'dislikes', 'abs', 'min', 'max', 'and', 'or', 'not', 'true', 'false']);
const FUNCTION_NAMES = new Set(['abs', 'min', 'max']);
const FIELD_NAMES = new Set(['likes', 'dislikes']);

export const DEFAULT_SOURCE_DEFINITIONS = [
  { key: 'best', where: 'true' },
  { key: 'controversial', where: 'max(likes, dislikes) > 0' }
];

export function getSourceDefinitions(config) {
  const configured = Array.isArray(config?.publish?.sources) ? config.publish.sources : [];
  const byKey = new Map(DEFAULT_SOURCE_DEFINITIONS.map((source) => [source.key, source]));
  for (const source of configured) {
    byKey.set(source.key, source);
  }
  return [...byKey.values()];
}

export function getSourceDefinition(config, key) {
  return getSourceDefinitions(config).find((source) => source.key === key) || null;
}

export function compileSourceWhere(expression = 'true') {
  const source = String(expression || 'true').trim();
  if (!source) return '1';
  if (!/^[\sA-Za-z0-9_().,+\-*/%!<>=]+$/.test(source)) {
    throw new Error('unsupported characters');
  }

  const tokens = tokenize(source);
  validateIdentifiers(tokens);
  const sql = tokens.map(sqlToken).join(' ');
  if (!hasBalancedParens(sql)) throw new Error('unbalanced parentheses');
  return sql;
}

export function compileReactionScore(strategy = 'likes') {
  if (strategy === 'dislikes') return 'dislikes';
  if (strategy === 'sum') return '(likes + dislikes)';
  if (strategy === 'max') return 'max(likes, dislikes)';
  if (strategy === 'likes') return 'likes';
  throw new Error(`Unsupported reaction strategy: ${strategy}`);
}

function tokenize(source) {
  const pattern = /\s*(>=|<=|!=|<>|==|=|>|<|\bAND\b|\bOR\b|\bNOT\b|\btrue\b|\bfalse\b|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/%,])\s*/giy;
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match.index !== index) {
      throw new Error(`invalid token near "${source.slice(index, index + 16)}"`);
    }
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

function validateIdentifiers(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) continue;
    const normalized = token.toLowerCase();
    if (!ALLOWED_IDENTIFIERS.has(normalized)) {
      throw new Error(`unsupported identifier: ${token}`);
    }
    if (FUNCTION_NAMES.has(normalized) && tokens[index + 1] !== '(') {
      throw new Error(`function ${token} must be called`);
    }
    if (FIELD_NAMES.has(normalized) && tokens[index + 1] === '(') {
      throw new Error(`field ${token} is not callable`);
    }
  }
}

function sqlToken(token) {
  const normalized = token.toLowerCase();
  if (normalized === 'and') return 'AND';
  if (normalized === 'or') return 'OR';
  if (normalized === 'not') return 'NOT';
  if (normalized === 'true') return '1';
  if (normalized === 'false') return '0';
  if (normalized === '==') return '=';
  if (normalized === '<>') return '!=';
  if (ALLOWED_IDENTIFIERS.has(normalized)) return normalized;
  return token;
}

function hasBalancedParens(sql) {
  let depth = 0;
  for (const char of sql) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
