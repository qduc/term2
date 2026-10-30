import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { recordSchema } from './contracts.js';
/** One authoritative CAS row per task. All counters and dispatch leases commit together. */
export class VerificationStore {
    #db;
    constructor(filename) {
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.#db = new Database(filename);
        chmodSync(filename, 0o600);
        this.#db.pragma('busy_timeout = 5000');
        this.#db.pragma('journal_mode = WAL');
        this.#db.pragma('synchronous = FULL');
        this.#db.exec(`
      CREATE TABLE IF NOT EXISTS completion_verification (
        task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS completion_verification_recovery (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, operator TEXT NOT NULL,
        reason TEXT NOT NULL, recorded_at INTEGER NOT NULL, previous_record TEXT NOT NULL
      );
    `);
    }
    read(taskId) {
        const row = this.#db.prepare('SELECT record FROM completion_verification WHERE task_id = ?').get(taskId);
        return row ? recordSchema.parse(JSON.parse(row.record)) : undefined;
    }
    /** Undefined generation means insert only. Terminal rows cannot be changed through this API. */
    write(record, expectedGeneration) {
        const value = recordSchema.parse(record);
        if (expectedGeneration === undefined) {
            return (this.#db
                .prepare('INSERT OR IGNORE INTO completion_verification VALUES (?, ?, ?)')
                .run(value.taskId, value.generation, JSON.stringify(value)).changes === 1);
        }
        if (value.generation !== expectedGeneration + 1)
            throw new Error('Invalid verification generation');
        return (this.#db
            .prepare(`UPDATE completion_verification SET generation = ?, record = ?
      WHERE task_id = ? AND generation = ?
      AND json_extract(record, '$.epoch') = ?
      AND json_extract(record, '$.state') IN ('VERIFICATION_PENDING', 'REPAIR_REQUIRED')`)
            .run(value.generation, JSON.stringify(value), value.taskId, expectedGeneration, value.epoch).changes === 1);
    }
    /** Explicit administrative recovery; audit and removal are atomic. Never called by a worker. */
    recover(taskId, operator, reason) {
        if (!operator.trim() || !reason.trim())
            throw new Error('Administrative recovery requires operator and reason');
        this.#db
            .transaction(() => {
            const previous = this.read(taskId);
            if (!previous)
                throw new Error('Unknown verification task');
            if (previous.state === 'VERIFICATION_PENDING' && previous.operationDeadline > Date.now())
                throw new Error('Cannot recover an in-flight verification before its deadline');
            this.#db
                .prepare(`INSERT INTO completion_verification_recovery
        (task_id, operator, reason, recorded_at, previous_record) VALUES (?, ?, ?, ?, ?)`)
                .run(taskId, operator, reason, Date.now(), JSON.stringify(previous));
            this.#db.prepare('DELETE FROM completion_verification WHERE task_id = ?').run(taskId);
        })
            .immediate();
    }
    close() {
        this.#db.close();
    }
}
//# sourceMappingURL=store.js.map