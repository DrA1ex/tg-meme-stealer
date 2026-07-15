const FUNCTION_ARITY = new Map([['abs', 1], ['min', 2], ['max', 2]]);
const FIELD_NAMES = new Set(['likes', 'dislikes']);

export const DEFAULT_SOURCE_DEFINITIONS = [
  { key: 'best', where: 'true' },
  { key: 'controversial', where: 'max(likes, dislikes) > 0' }
];

export function getSourceDefinitions(config) {
  const configured = Array.isArray(config?.publish?.sources) ? config.publish.sources : [];
  const byKey = new Map(DEFAULT_SOURCE_DEFINITIONS.map((source) => [source.key, source]));
  for (const source of configured) byKey.set(source.key, source);
  return [...byKey.values()];
}

export function getSourceDefinition(config, key) {
  return getSourceDefinitions(config).find((source) => source.key === key) || null;
}

export function compileSourceWhere(expression = 'true') {
  const source = String(expression || 'true').trim();
  if (!source) return '1';
  if (!/^[\sA-Za-z0-9_().,+\-*/%!<>=]+$/.test(source)) throw new Error('unsupported characters');
  const parser = new SourceExpressionParser(tokenize(source));
  const ast = parser.parse();
  return compileNode(ast);
}

export function compileReactionScore(strategy = 'likes') {
  if (strategy === 'dislikes') return 'dislikes';
  if (strategy === 'sum') return '(likes + dislikes)';
  if (strategy === 'max') return 'max(likes, dislikes)';
  if (strategy === 'likes') return 'likes';
  throw new Error(`Unsupported reaction strategy: ${strategy}`);
}

class SourceExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  parse() {
    if (this.tokens.length === 0) throw new Error('expression is empty');
    const node = this.parseOr();
    if (!this.isEnd()) throw new Error(`unexpected token: ${this.peek()}`);
    return node;
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.matchKeyword('or')) node = binary('OR', node, this.parseAnd());
    return node;
  }

  parseAnd() {
    let node = this.parseComparison();
    while (this.matchKeyword('and')) node = binary('AND', node, this.parseComparison());
    return node;
  }

  parseComparison() {
    let node = this.parseAdditive();
    const token = this.peek();
    if (['=', '==', '!=', '<>', '>', '<', '>=', '<='].includes(token)) {
      this.index += 1;
      node = binary(token === '==' ? '=' : token === '<>' ? '!=' : token, node, this.parseAdditive());
      if (['=', '==', '!=', '<>', '>', '<', '>=', '<='].includes(this.peek())) {
        throw new Error('chained comparisons are not supported');
      }
    }
    return node;
  }

  parseAdditive() {
    let node = this.parseMultiplicative();
    while (['+', '-'].includes(this.peek())) {
      const operator = this.next();
      node = binary(operator, node, this.parseMultiplicative());
    }
    return node;
  }

  parseMultiplicative() {
    let node = this.parseUnary();
    while (['*', '/', '%'].includes(this.peek())) {
      const operator = this.next();
      node = binary(operator, node, this.parseUnary());
    }
    return node;
  }

  parseUnary() {
    if (this.matchKeyword('not')) return { type: 'unary', operator: 'NOT', value: this.parseUnary() };
    if (this.peek() === '!' || this.peek() === '+' || this.peek() === '-') {
      const operator = this.next();
      return { type: 'unary', operator: operator === '!' ? 'NOT' : operator, value: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.next();
    if (token === undefined) throw new Error('expected an expression');
    if (token === '(') {
      const value = this.parseOr();
      this.expect(')');
      return value;
    }
    if (/^\d+(?:\.\d+)?$/.test(token)) return { type: 'literal', value: token };

    const normalized = token.toLowerCase();
    if (normalized === 'true' || normalized === 'false') return { type: 'literal', value: normalized === 'true' ? '1' : '0' };
    if (FIELD_NAMES.has(normalized)) {
      if (this.peek() === '(') throw new Error(`field ${token} is not callable`);
      return { type: 'field', name: normalized };
    }
    if (FUNCTION_ARITY.has(normalized)) return this.parseFunction(normalized);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      if (this.peek() === '(') throw new Error(`unsupported function: ${token}`);
      throw new Error(`unsupported identifier: ${token}`);
    }
    throw new Error(`unexpected token: ${token}`);
  }

  parseFunction(name) {
    this.expect('(');
    const args = [];
    if (this.peek() !== ')') {
      do {
        args.push(this.parseOr());
      } while (this.match(','));
    }
    this.expect(')');
    const expected = FUNCTION_ARITY.get(name);
    if (args.length !== expected) throw new Error(`function ${name} expects ${expected} argument${expected === 1 ? '' : 's'}`);
    return { type: 'function', name, args };
  }

  match(value) {
    if (this.peek() !== value) return false;
    this.index += 1;
    return true;
  }

  matchKeyword(value) {
    if (String(this.peek() || '').toLowerCase() !== value) return false;
    this.index += 1;
    return true;
  }

  expect(value) {
    if (!this.match(value)) throw new Error(`expected "${value}", got "${this.peek() ?? 'end of expression'}"`);
  }

  peek() { return this.tokens[this.index]; }
  next() { return this.tokens[this.index++]; }
  isEnd() { return this.index >= this.tokens.length; }
}

function tokenize(source) {
  const pattern = /\s*(>=|<=|!=|<>|==|=|>|<|\bAND\b|\bOR\b|\bNOT\b|\btrue\b|\bfalse\b|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/%,!])\s*/giy;
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match.index !== index) throw new Error(`invalid token near "${source.slice(index, index + 16)}"`);
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

function binary(operator, left, right) {
  return { type: 'binary', operator, left, right };
}

function compileNode(node) {
  if (node.type === 'literal') return node.value;
  if (node.type === 'field') return node.name;
  if (node.type === 'function') return `${node.name}(${node.args.map(compileNode).join(', ')})`;
  if (node.type === 'unary') return `(${node.operator} ${compileNode(node.value)})`;
  if (node.type === 'binary') return `(${compileNode(node.left)} ${node.operator} ${compileNode(node.right)})`;
  throw new Error(`Unsupported expression node: ${node.type}`);
}
