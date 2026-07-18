const MIGRATIONS = [
  {
    name: '0000_initial',
    async up(db) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS posts (
          chat_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          author TEXT,
          text TEXT,
          likes INTEGER NOT NULL DEFAULT 0,
          dislikes INTEGER NOT NULL DEFAULT 0,
          data TEXT NOT NULL DEFAULT '{}',
          message_date TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(message_date);
        CREATE INDEX IF NOT EXISTS idx_posts_score ON posts(likes, dislikes);

        CREATE TABLE IF NOT EXISTS publications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT,
          selection_key TEXT NOT NULL,
          title TEXT NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          last_error TEXT,
          lease_owner TEXT,
          lease_until TEXT,
          data TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS publication_posts (
          publication_id INTEGER NOT NULL,
          chat_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          position INTEGER NOT NULL,
          likes INTEGER NOT NULL,
          dislikes INTEGER NOT NULL,
          bot_message_id INTEGER,
          sent_at TEXT,
          send_state TEXT NOT NULL DEFAULT 'sent',
          PRIMARY KEY (publication_id, chat_id, message_id),
          FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
        );
      `);
      await ensureColumn(db, 'publications', 'lease_owner', 'TEXT');
      await ensureColumn(db, 'publications', 'lease_until', 'TEXT');
      await ensureColumn(db, 'publication_posts', 'send_state', "TEXT NOT NULL DEFAULT 'sent'");
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_key_active_v2
        ON publications(key)
        WHERE key IS NOT NULL AND status IN ('created', 'header_sending', 'running', 'uncertain', 'published')
      `);
    }
  },
  {
    name: '0001_publication_reliability',
    async up(db) {
      await ensureColumn(db, 'publications', 'last_progress_at', 'TEXT');
      await ensureColumn(db, 'publications', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
      await ensureColumn(db, 'publications', 'next_attempt_at', 'TEXT');
      await ensureColumn(db, 'publications', 'last_error_code', 'TEXT');
      await ensureColumn(db, 'publication_posts', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
      await ensureColumn(db, 'publication_posts', 'last_error', 'TEXT');
      await ensureColumn(db, 'publication_posts', 'last_error_code', 'TEXT');
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_publications_queue_v3
        ON publications(status, next_attempt_at, lease_until, created_at)
      `);
    }
  },
  {
    name: '0002_delivery_commit_state',
    async up(db) {
      await ensureColumn(db, 'publications', 'header_message_id', 'INTEGER');
      await db.exec(`
        DROP INDEX IF EXISTS idx_publications_key_active_v2;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_key_active_v3
        ON publications(key)
        WHERE key IS NOT NULL AND status IN (
          'created', 'header_sending', 'header_delivered', 'running', 'uncertain', 'published'
        );
      `);
    }
  },
  {
    name: '0003_pending_error_logs',
    async up(db) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS pending_error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          scope TEXT NOT NULL,
          message TEXT NOT NULL,
          error TEXT,
          fields TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_pending_error_logs_type_time
        ON pending_error_logs(type, timestamp, id);
      `);
    }
  }
];

export async function runMigrations(db, logger = null) {
  const row = await db.get('PRAGMA user_version');
  let version = Number(row?.user_version || 0);
  if (version > MIGRATIONS.length) {
    throw new Error(`Database schema version ${version} is newer than supported version ${MIGRATIONS.length}`);
  }

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    logger?.info?.('Applying database migration', { migration: migration.name, fromVersion: index, toVersion: index + 1 });
    await db.exec('BEGIN IMMEDIATE');
    try {
      await migration.up(db);
      await db.exec(`PRAGMA user_version = ${index + 1}`);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      error.message = `Database migration ${migration.name} failed: ${error.message}`;
      throw error;
    }
  }
  return MIGRATIONS.length;
}

export function getMigrations() {
  return MIGRATIONS.map((migration, index) => ({ version: index + 1, name: migration.name }));
}

async function ensureColumn(db, table, column, definition) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  if (columns.some((item) => item.name === column)) return;
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
