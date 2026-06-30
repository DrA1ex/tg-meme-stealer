import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, formatLogLine } from '../src/core/logger.js';

test('formatLogLine renders timestamp, level, scope and fields', () => {
  const line = formatLogLine({
    level: 'info',
    scope: 'scanner',
    message: 'Sync started',
    fields: { page: 1, mode: 'user', hasNext: true },
    now: new Date('2026-06-29T00:00:00.000Z')
  });

  assert.equal(line, '2026-06-29T00:00:00.000Z [INFO] [scanner] Sync started page=1 mode="user" hasNext=true');
});

test('createLogger respects configured level', () => {
  const lines = [];
  const logger = createLogger({ logging: { logLevel: 'WARN' } }, 'test', {
    log: (line) => lines.push(['log', line]),
    warn: (line) => lines.push(['warn', line]),
    error: (line) => lines.push(['error', line])
  });

  logger.info('Hidden');
  logger.warn('Visible', { count: 2 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'warn');
  assert.match(lines[0][1], /\[WARN\] \[test\] Visible count=2/);
});
