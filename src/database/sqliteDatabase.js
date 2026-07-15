import Database from 'better-sqlite3';

export function openSqliteDatabase(filename) {
  const database = new Database(filename, { timeout: 5000 });

  return {
    run(sql, params = []) {
      const statement = database.prepare(sql);
      if (statement.reader) {
        const row = invoke(statement, 'get', params);
        return { changes: 0, lastID: null, row };
      }

      const result = invoke(statement, 'run', params);
      return {
        changes: Number(result.changes || 0),
        lastID: normalizeInteger(result.lastInsertRowid)
      };
    },

    get(sql, params = []) {
      return invoke(database.prepare(sql), 'get', params);
    },

    all(sql, params = []) {
      return invoke(database.prepare(sql), 'all', params);
    },

    exec(sql) {
      database.exec(sql);
    },

    close() {
      database.close();
    }
  };
}

function invoke(statement, method, params) {
  if (Array.isArray(params)) return statement[method](...params);
  if (params === undefined || params === null) return statement[method]();
  return statement[method](params);
}

function normalizeInteger(value) {
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new RangeError(`SQLite integer exceeds JavaScript safe range: ${value}`);
    }
    return number;
  }
  return value === undefined ? null : value;
}
