import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  GatewayPersistenceError,
  type AdmissionRecord,
  type GatewaySessionRecord,
  type GatewaySessionStatus,
  type SessionListPage,
} from './contracts.js';
import type { GatewayStorageLayout } from './storage.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type Row = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionFromRow(row: Row): GatewaySessionRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    workspaceId: String(row.workspace_id),
    grantVersion: String(row.grant_version),
    bindingFingerprint: String(row.binding_fingerprint),
    status: String(row.status) as GatewaySessionStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastAppendedSequence: Number(row.last_appended_sequence),
    lastPublishedSequence: Number(row.last_published_sequence),
    firstRetainedEventSequence: Number(row.first_retained_event_sequence),
    projectionSequence: Number(row.projection_sequence),
    transcriptGeneration: Number(row.transcript_generation),
    activeTurnId: optionalString(row.active_turn_id),
    interruptedAt: optionalString(row.interrupted_at),
    recoveryWarning: optionalString(row.recovery_warning),
    retentionEligibleAt: optionalString(row.retention_eligible_at),
  };
}

function admissionFromRow(row: Row): AdmissionRecord {
  return {
    ownerUserId: String(row.owner_user_id),
    sessionId: String(row.session_id),
    clientRequestId: String(row.client_request_id),
    normalizedBodyHash: String(row.normalized_body_hash),
    turnId: String(row.turn_id),
    state: String(row.state) as AdmissionRecord['state'],
    result: optionalString(row.result) as AdmissionRecord['result'],
    phase: optionalString(row.phase) as AdmissionRecord['phase'],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    transcriptChecksum: optionalString(row.transcript_checksum),
    journalChecksum: optionalString(row.journal_checksum),
  };
}

function encodeCursor(value: { ownerUserId: string; updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, ownerUserId: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.ownerUserId !== ownerUserId || typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error();
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new GatewayPersistenceError('cursor_invalid', 'session list cursor is invalid for this owner');
  }
}

export class GatewaySessionIndex {
  readonly #db: DatabaseSync;
  #closed = false;
  #readonly = false;
  readonly #closedRetentionMs: number;

  constructor(layout: GatewayStorageLayout, options: { closedRetentionMs?: number } = {}) {
    try {
      this.#closedRetentionMs = options.closedRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
      this.#db = new DatabaseSync(layout.indexPath);
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_sessions (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          grant_version TEXT NOT NULL,
          binding_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_appended_sequence INTEGER NOT NULL DEFAULT 0,
          last_published_sequence INTEGER NOT NULL DEFAULT 0,
          first_retained_event_sequence INTEGER NOT NULL DEFAULT 1,
          projection_sequence INTEGER NOT NULL DEFAULT 0,
          transcript_generation INTEGER NOT NULL DEFAULT 1,
          active_turn_id TEXT,
          interrupted_at TEXT,
          recovery_warning TEXT,
          retention_eligible_at TEXT,
          tombstone INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS gateway_sessions_owner_updated
          ON gateway_sessions(owner_user_id, updated_at DESC, id ASC);
        CREATE TABLE IF NOT EXISTS gateway_admissions (
          owner_user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          client_request_id TEXT NOT NULL,
          normalized_body_hash TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          state TEXT NOT NULL,
          result TEXT,
          phase TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          transcript_checksum TEXT,
          journal_checksum TEXT,
          PRIMARY KEY (owner_user_id, session_id, client_request_id),
          FOREIGN KEY (session_id) REFERENCES gateway_sessions(id)
        );
      `);
      for (const column of ['transcript_checksum', 'journal_checksum']) {
        try {
          this.#db.exec(`ALTER TABLE gateway_admissions ADD COLUMN ${column} TEXT`);
        } catch {
          // Existing databases already have this migration column.
        }
      }
      this.assertIntegrity();
      fs.chmodSync(layout.indexPath, 0o600);
    } catch (error) {
      if (error instanceof GatewayPersistenceError) throw error;
      throw new GatewayPersistenceError('integrity_failed', 'gateway index integrity check failed');
    }
  }

  #transaction<T>(operation: () => T): T {
    this.assertHealthy();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  get readonly(): boolean {
    return this.#readonly;
  }

  assertHealthy(): void {
    if (this.#closed) throw new GatewayPersistenceError('readonly', 'gateway index is closed');
    if (this.#readonly) throw new GatewayPersistenceError('integrity_failed', 'gateway index is read-only');
  }

  assertIntegrity(): void {
    const row = this.#db.prepare('PRAGMA integrity_check').get() as Row;
    if (row.integrity_check !== 'ok') {
      this.#readonly = true;
      throw new GatewayPersistenceError('integrity_failed', 'gateway index integrity check failed');
    }
  }

  create(
    record: Omit<
      GatewaySessionRecord,
      | 'lastAppendedSequence'
      | 'lastPublishedSequence'
      | 'firstRetainedEventSequence'
      | 'projectionSequence'
      | 'transcriptGeneration'
    > &
      Partial<
        Pick<
          GatewaySessionRecord,
          | 'lastAppendedSequence'
          | 'lastPublishedSequence'
          | 'firstRetainedEventSequence'
          | 'projectionSequence'
          | 'transcriptGeneration'
        >
      >,
  ): GatewaySessionRecord {
    this.assertHealthy();
    try {
      return this.#transaction(() => {
        this.#db
          .prepare(
            `
          INSERT INTO gateway_sessions
          (id, owner_user_id, workspace_id, grant_version, binding_fingerprint, status, created_at, updated_at,
           last_appended_sequence, last_published_sequence, first_retained_event_sequence, projection_sequence,
           transcript_generation, active_turn_id, interrupted_at, recovery_warning, retention_eligible_at, tombstone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `,
          )
          .run(
            record.id,
            record.ownerUserId,
            record.workspaceId,
            record.grantVersion,
            record.bindingFingerprint,
            record.status,
            record.createdAt,
            record.updatedAt,
            record.lastAppendedSequence ?? 0,
            record.lastPublishedSequence ?? 0,
            record.firstRetainedEventSequence ?? 1,
            record.projectionSequence ?? 0,
            record.transcriptGeneration ?? 1,
            record.activeTurnId ?? null,
            record.interruptedAt ?? null,
            record.recoveryWarning ?? null,
            record.retentionEligibleAt ?? null,
          );
        return this.get(record.id)!;
      });
    } catch (error) {
      if (error instanceof GatewayPersistenceError) throw error;
      throw new GatewayPersistenceError('conflict', 'session already exists or could not be created');
    }
  }

  get(sessionId: string): GatewaySessionRecord | null {
    if (this.#closed) throw new GatewayPersistenceError('readonly', 'gateway index is closed');
    const row = this.#db.prepare('SELECT * FROM gateway_sessions WHERE id = ? AND tombstone = 0').get(sessionId) as
      | Row
      | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getForOwner(ownerUserId: string, sessionId: string): GatewaySessionRecord {
    const record = this.get(sessionId);
    if (!record) throw new GatewayPersistenceError('not_found', 'session not found');
    if (record.ownerUserId !== ownerUserId) throw new GatewayPersistenceError('owner_mismatch', 'session not found');
    return record;
  }

  list(ownerUserId: string, options: { limit?: number; cursor?: string } = {}): SessionListPage {
    if (this.#closed) throw new GatewayPersistenceError('readonly', 'gateway index is closed');
    const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const cursor = options.cursor ? decodeCursor(options.cursor, ownerUserId) : null;
    const rows = (
      cursor
        ? this.#db
            .prepare(
              `SELECT * FROM gateway_sessions WHERE owner_user_id = ? AND tombstone = 0 AND status != 'initializing'
         AND (updated_at < ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at DESC, id ASC LIMIT ?`,
            )
            .all(ownerUserId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1)
        : this.#db
            .prepare(
              `SELECT * FROM gateway_sessions WHERE owner_user_id = ? AND tombstone = 0 AND status != 'initializing'
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
            )
            .all(ownerUserId, limit + 1)
    ) as Row[];
    const pageRows = rows.slice(0, limit);
    const sessions = pageRows.map((row) => {
      const record = sessionFromRow(row);
      return {
        id: record.id,
        workspaceId: record.workspaceId,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        latestSequence: record.lastPublishedSequence,
      };
    });
    const nextCursor =
      rows.length > limit && pageRows.length > 0
        ? encodeCursor({
            ownerUserId,
            updatedAt: sessions[sessions.length - 1]!.updatedAt,
            id: sessions[sessions.length - 1]!.id,
          })
        : null;
    return { sessions, nextCursor };
  }

  update(
    sessionId: string,
    patch: Partial<
      Pick<
        GatewaySessionRecord,
        | 'status'
        | 'updatedAt'
        | 'lastAppendedSequence'
        | 'lastPublishedSequence'
        | 'firstRetainedEventSequence'
        | 'projectionSequence'
        | 'transcriptGeneration'
      >
    > & {
      activeTurnId?: string | null;
      interruptedAt?: string | null;
      recoveryWarning?: string | null;
      retentionEligibleAt?: string | null;
    },
  ): GatewaySessionRecord {
    this.assertHealthy();
    const current = this.get(sessionId);
    if (!current) throw new GatewayPersistenceError('not_found', 'session not found');
    const allowed = {
      status: patch.status ?? current.status,
      updatedAt: patch.updatedAt ?? current.updatedAt,
      lastAppendedSequence: patch.lastAppendedSequence ?? current.lastAppendedSequence,
      lastPublishedSequence: patch.lastPublishedSequence ?? current.lastPublishedSequence,
      firstRetainedEventSequence: patch.firstRetainedEventSequence ?? current.firstRetainedEventSequence,
      projectionSequence: patch.projectionSequence ?? current.projectionSequence,
      transcriptGeneration: patch.transcriptGeneration ?? current.transcriptGeneration,
      activeTurnId: patch.activeTurnId === undefined ? current.activeTurnId ?? null : patch.activeTurnId,
      interruptedAt: patch.interruptedAt === undefined ? current.interruptedAt ?? null : patch.interruptedAt,
      recoveryWarning: patch.recoveryWarning === undefined ? current.recoveryWarning ?? null : patch.recoveryWarning,
      retentionEligibleAt:
        patch.retentionEligibleAt === undefined
          ? patch.status === 'closed'
            ? new Date(Date.now() + this.#closedRetentionMs).toISOString()
            : current.retentionEligibleAt ?? null
          : patch.retentionEligibleAt,
    };
    return this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE gateway_sessions SET status=?, updated_at=?, last_appended_sequence=?, last_published_sequence=?,
        first_retained_event_sequence=?, projection_sequence=?, transcript_generation=?, active_turn_id=?, interrupted_at=?,
        recovery_warning=?, retention_eligible_at=? WHERE id=? AND tombstone=0`,
        )
        .run(
          allowed.status,
          allowed.updatedAt,
          allowed.lastAppendedSequence,
          allowed.lastPublishedSequence,
          allowed.firstRetainedEventSequence,
          allowed.projectionSequence,
          allowed.transcriptGeneration,
          allowed.activeTurnId,
          allowed.interruptedAt,
          allowed.recoveryWarning,
          allowed.retentionEligibleAt,
          sessionId,
        );
      return this.get(sessionId)!;
    });
  }

  listEvictionCandidates(now = new Date().toISOString(), limit = 100): GatewaySessionRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM gateway_sessions WHERE status='closed' AND tombstone=0
      AND retention_eligible_at IS NOT NULL AND retention_eligible_at <= ?
      ORDER BY updated_at ASC, id ASC LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(limit, 1000))) as Row[];
    return rows.map(sessionFromRow);
  }

  removeTombstoned(sessionId: string): void {
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM gateway_sessions WHERE id=? AND tombstone=1').run(sessionId);
    });
  }

  tombstone(sessionId: string): void {
    this.assertHealthy();
    const record = this.get(sessionId);
    if (!record) throw new GatewayPersistenceError('not_found', 'session not found');
    if (record.status !== 'closed')
      throw new GatewayPersistenceError('conflict', 'only closed sessions may be deleted');
    this.#transaction(() => {
      this.#db
        .prepare('UPDATE gateway_sessions SET tombstone=1, updated_at=? WHERE id=?')
        .run(new Date().toISOString(), sessionId);
    });
  }

  admission(ownerUserId: string, sessionId: string, clientRequestId: string): AdmissionRecord | null {
    const row = this.#db
      .prepare(`SELECT * FROM gateway_admissions WHERE owner_user_id=? AND session_id=? AND client_request_id=?`)
      .get(ownerUserId, sessionId, clientRequestId) as Row | undefined;
    return row ? admissionFromRow(row) : null;
  }

  insertAdmission(record: AdmissionRecord): void {
    this.assertHealthy();
    try {
      this.#transaction(() => {
        this.#db
          .prepare(
            `INSERT INTO gateway_admissions
          (owner_user_id, session_id, client_request_id, normalized_body_hash, turn_id, state, result, phase, created_at, expires_at,
           transcript_checksum, journal_checksum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.ownerUserId,
            record.sessionId,
            record.clientRequestId,
            record.normalizedBodyHash,
            record.turnId,
            record.state,
            record.result ?? null,
            record.phase ?? null,
            record.createdAt,
            record.expiresAt,
            record.transcriptChecksum ?? null,
            record.journalChecksum ?? null,
          );
      });
    } catch (error) {
      if (error instanceof GatewayPersistenceError) throw error;
      throw new GatewayPersistenceError('conflict', 'admission already exists or violates its session binding');
    }
  }

  updateAdmission(
    ownerUserId: string,
    sessionId: string,
    clientRequestId: string,
    patch: Partial<Pick<AdmissionRecord, 'state' | 'result' | 'phase' | 'transcriptChecksum' | 'journalChecksum'>>,
  ): AdmissionRecord {
    this.assertHealthy();
    const current = this.admission(ownerUserId, sessionId, clientRequestId);
    if (!current) throw new GatewayPersistenceError('not_found', 'admission not found');
    return this.#transaction(() => {
      this.#db
        .prepare(
          'UPDATE gateway_admissions SET state=?, result=?, phase=?, transcript_checksum=?, journal_checksum=? WHERE owner_user_id=? AND session_id=? AND client_request_id=?',
        )
        .run(
          patch.state ?? current.state,
          patch.result ?? current.result ?? null,
          patch.phase ?? current.phase ?? null,
          patch.transcriptChecksum ?? current.transcriptChecksum ?? null,
          patch.journalChecksum ?? current.journalChecksum ?? null,
          ownerUserId,
          sessionId,
          clientRequestId,
        );
      return this.admission(ownerUserId, sessionId, clientRequestId)!;
    });
  }

  deleteAdmission(ownerUserId: string, sessionId: string, clientRequestId: string): void {
    this.assertHealthy();
    this.#transaction(() => {
      this.#db
        .prepare('DELETE FROM gateway_admissions WHERE owner_user_id=? AND session_id=? AND client_request_id=?')
        .run(ownerUserId, sessionId, clientRequestId);
    });
  }

  listAdmissions(ownerUserId: string, sessionId: string): AdmissionRecord[] {
    if (this.#closed) throw new GatewayPersistenceError('readonly', 'gateway index is closed');
    return (
      this.#db
        .prepare('SELECT * FROM gateway_admissions WHERE owner_user_id=? AND session_id=? ORDER BY created_at ASC')
        .all(ownerUserId, sessionId) as Row[]
    ).map(admissionFromRow);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
