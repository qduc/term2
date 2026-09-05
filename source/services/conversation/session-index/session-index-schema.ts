import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = '1';
export const PROJECTION_VERSION = '1';

export type ProbeCapabilityResult = { ok: true } | { ok: false; reason: string };

/**
 * Hard capability probe required before using the SQLite index.
 * Creates a disposable virtual table with FTS5 and the trigram tokenizer,
 * then immediately drops it.
 */
export function probeFts5TrigramCapability(db: Database.Database): ProbeCapabilityResult {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_trigram_capability_probe USING fts5(
        content,
        tokenize='trigram'
      );
      DROP TABLE IF EXISTS _fts5_trigram_capability_probe;
    `);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `FTS5 trigram tokenizer capability probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Creates schema v1 tables and indexes.
 * Foreign keys with CASCADE are used to cleanly delete sessions and messages
 * when an inventory entry is removed.
 */
export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_inventory (
      session_id TEXT PRIMARY KEY,
      source_version TEXT NOT NULL,
      classification TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_inventory_classification
      ON source_inventory(classification);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      ssh_host TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      predecessor_id TEXT,
      model TEXT,
      provider TEXT,
      first_user_snippet TEXT,
      projected_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL,
      projection_revision TEXT NOT NULL,
      FOREIGN KEY (id) REFERENCES source_inventory(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_scope_updated
      ON sessions(project_path, ssh_host, updated_at DESC, id ASC);

    CREATE INDEX IF NOT EXISTS idx_sessions_predecessor
      ON sessions(predecessor_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      projected_ordinal INTEGER NOT NULL,
      original_message_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      original_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal
      ON messages(session_id, projected_ordinal ASC);
  `);
}

/**
 * Checks whether the database has current schema and matches the given canonical source directory.
 */
export function isSchemaCurrent(db: Database.Database, sourceDirectory: string): boolean {
  try {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_metadata'").get();
    if (!tableExists) return false;

    const schemaRow = db.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!schemaRow || schemaRow.value !== SCHEMA_VERSION) return false;

    const projRow = db.prepare("SELECT value FROM index_metadata WHERE key = 'projection_version'").get() as
      | { value: string }
      | undefined;
    if (!projRow || projRow.value !== PROJECTION_VERSION) return false;

    const dirRow = db.prepare("SELECT value FROM index_metadata WHERE key = 'source_directory'").get() as
      | { value: string }
      | undefined;
    if (!dirRow || dirRow.value !== sourceDirectory) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Records or updates metadata for current schema and source directory.
 */
export function writeMetadata(db: Database.Database, sourceDirectory: string): void {
  const insert = db.prepare(`
    INSERT INTO index_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  insert.run('schema_version', SCHEMA_VERSION);
  insert.run('projection_version', PROJECTION_VERSION);
  insert.run('source_directory', sourceDirectory);
}

/**
 * Drops all schema tables cleanly to enable rebuild on schema version or directory change.
 */
export function dropSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS source_inventory;
    DROP TABLE IF EXISTS index_metadata;
  `);
}
