import { DatabaseSync } from 'node:sqlite';

export type ReplayKey = {
  iss: string;
  jti: string;
  purpose: string;
  sub: string;
  sessionId?: string;
  exp: number;
};

export interface ReplayLedger {
  /** Atomically records a key, returning false when it was already recorded. */
  record(key: ReplayKey, nowSeconds?: number): boolean;
  purge(nowSeconds?: number): void;
  close(): void;
}

/** Durable replay authority. The database, not the process cache, is authoritative. */
export class SqliteReplayLedger implements ReplayLedger {
  readonly #db: DatabaseSync;
  readonly #insert: ReturnType<DatabaseSync['prepare']>;
  readonly #purge: ReturnType<DatabaseSync['prepare']>;

  constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gateway_assertion_replay_v2 (
        iss TEXT NOT NULL,
        jti TEXT NOT NULL,
        purpose TEXT NOT NULL,
        sub TEXT NOT NULL,
        session_id TEXT NOT NULL,
        exp INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (iss, jti)
      );
      CREATE INDEX IF NOT EXISTS gateway_assertion_replay_v2_exp
        ON gateway_assertion_replay_v2(exp);
    `);
    // Import rows from the pre-correction table when upgrading an existing
    // daemon. The v2 table is the sole authority and collapses duplicate jtis.
    try {
      this.#db.exec(`
        INSERT OR IGNORE INTO gateway_assertion_replay_v2
          (iss, jti, purpose, sub, session_id, exp, recorded_at)
        SELECT iss, jti, purpose, sub, session_id, exp, recorded_at
        FROM gateway_assertion_replay
      `);
    } catch {
      // Fresh databases do not have the pre-correction table.
    }
    this.#insert = this.#db.prepare(`
      INSERT INTO gateway_assertion_replay_v2
        (iss, jti, purpose, sub, session_id, exp, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#purge = this.#db.prepare('DELETE FROM gateway_assertion_replay_v2 WHERE exp < ?');
  }

  record(key: ReplayKey, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    this.purge(nowSeconds);
    try {
      this.#insert.run(key.iss, key.jti, key.purpose, key.sub, key.sessionId ?? '', key.exp, nowSeconds);
      return true;
    } catch (error) {
      if (error instanceof Error && /constraint|unique/i.test(error.message)) return false;
      throw error;
    }
  }

  purge(nowSeconds = Math.floor(Date.now() / 1000)): void {
    this.#purge.run(nowSeconds);
  }

  close(): void {
    this.#db.close();
  }
}

/** Small deterministic ledger useful for unit tests and embedded callers. */
export class MemoryReplayLedger implements ReplayLedger {
  readonly #entries = new Map<string, number>();

  record(key: ReplayKey, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    this.purge(nowSeconds);
    const composite = [key.iss, key.jti].join('\u0000');
    if (this.#entries.has(composite)) return false;
    this.#entries.set(composite, key.exp);
    return true;
  }

  purge(nowSeconds = Math.floor(Date.now() / 1000)): void {
    for (const [key, exp] of this.#entries) if (exp < nowSeconds) this.#entries.delete(key);
  }

  close(): void {
    this.#entries.clear();
  }
}
