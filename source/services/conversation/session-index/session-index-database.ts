import Database from 'better-sqlite3';
import fs from 'node:fs';
import {
  createSchema,
  dropSchema,
  isSchemaCurrent,
  probeFts5TrigramCapability,
  writeMetadata,
  type ProbeCapabilityResult,
} from './session-index-schema.js';
import {
  getConversationSourceVersionReadOnly,
  loadConversationForProjectReadOnly,
  normalizeProjectPath,
  normalizeSshHost,
  resolveConversationReference,
  uniqueConversationShortRefs,
} from '../conversation-persistence.js';
import {
  isBrowsableSession,
  prefixSnippet,
  projectMessages,
  sessionRevision,
  sessionUpdatedAt,
} from '../session-browser.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type ReconcileResult = {
  ok: boolean;
  replayedCount: number;
  deletedCount: number;
  stable: boolean;
  changedDuringReplay?: string[];
  error?: string;
};

export type IndexedSession = {
  id: string;
  shortRef: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  firstUserMessage?: string;
  messageCount: number;
};

export type IndexedListResult = {
  sessions: IndexedSession[];
  scope: string;
  total: number;
  unavailable: number;
};

export type IndexedResolveResult =
  | { kind: 'resolved'; id: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; shortRef: string }> };

export class SessionIndexDatabase {
  readonly #db: Database.Database;
  readonly #sourceDirectory: string;

  constructor(dbPath: string, sourceDirectory: string, options?: { timeout?: number }) {
    this.#sourceDirectory = sourceDirectory;
    this.#db = new Database(dbPath, { timeout: options?.timeout ?? 5000 });
    this.#configurePragmas();
  }

  get database(): Database.Database {
    return this.#db;
  }

  #configurePragmas(): void {
    try {
      this.#db.pragma('journal_mode = WAL');
    } catch {
      // Ignored for in-memory or read-only databases
    }
    this.#db.pragma('busy_timeout = 5000');
    this.#db.pragma('foreign_keys = ON');
    try {
      this.#db.pragma('synchronous = NORMAL');
    } catch {
      // Best-effort
    }
  }

  probeCapability(): ProbeCapabilityResult {
    return probeFts5TrigramCapability(this.#db);
  }

  initialize(): void {
    if (!isSchemaCurrent(this.#db, this.#sourceDirectory)) {
      dropSchema(this.#db);
      createSchema(this.#db);
      writeMetadata(this.#db, this.#sourceDirectory);
    }
  }

  reconcile(): ReconcileResult {
    this.initialize();

    let files: string[] = [];
    try {
      if (fs.existsSync(this.#sourceDirectory)) {
        files = fs.readdirSync(this.#sourceDirectory).filter((f) => f.endsWith('.jsonl'));
      }
    } catch (error) {
      return {
        ok: false,
        replayedCount: 0,
        deletedCount: 0,
        stable: false,
        error: `Failed to read source directory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const liveIds = new Set<string>();
    for (const file of files) {
      const id = file.slice(0, -'.jsonl'.length);
      if (SAFE_SESSION_ID.test(id)) {
        liveIds.add(id);
      }
    }

    // 1. Remove deleted sessions from inventory
    const existingInventoryRows = this.#db
      .prepare('SELECT session_id, source_version FROM source_inventory')
      .all() as Array<{ session_id: string; source_version: string }>;

    let deletedCount = 0;
    const deleteInventoryStmt = this.#db.prepare('DELETE FROM source_inventory WHERE session_id = ?');
    const deleteSessionStmt = this.#db.prepare('DELETE FROM sessions WHERE id = ?');
    const deleteMessageStmt = this.#db.prepare('DELETE FROM messages WHERE session_id = ?');

    const deleteTx = this.#db.transaction((toDelete: string[]) => {
      for (const id of toDelete) {
        deleteMessageStmt.run(id);
        deleteSessionStmt.run(id);
        deleteInventoryStmt.run(id);
      }
    });

    const toDeleteIds: string[] = [];
    const existingVersionMap = new Map<string, string>();
    for (const row of existingInventoryRows) {
      if (!liveIds.has(row.session_id)) {
        toDeleteIds.push(row.session_id);
      } else {
        existingVersionMap.set(row.session_id, row.source_version);
      }
    }

    if (toDeleteIds.length > 0) {
      deleteTx(toDeleteIds);
      deletedCount = toDeleteIds.length;
    }

    // 2. Identify sessions requiring refresh
    const toRefreshIds: string[] = [];
    for (const id of liveIds) {
      const currentVersion = getConversationSourceVersionReadOnly(id);
      if (currentVersion === null) continue;
      if (existingVersionMap.get(id) !== currentVersion) {
        toRefreshIds.push(id);
      }
    }

    let replayedCount = 0;
    const changedDuringReplay: string[] = [];

    // Prepared statements for insertion
    const insertInventoryStmt = this.#db.prepare(`
      INSERT INTO source_inventory (session_id, source_version, classification, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        source_version = excluded.source_version,
        classification = excluded.classification,
        updated_at = excluded.updated_at
    `);

    const insertSessionStmt = this.#db.prepare(`
      INSERT INTO sessions (
        id, project_path, ssh_host, created_at, updated_at, predecessor_id,
        model, provider, first_user_snippet, projected_count, skipped_count, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMessageStmt = this.#db.prepare(`
      INSERT INTO messages (
        session_id, projected_ordinal, original_message_index, kind, original_text, normalized_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Refresh each changed session
    for (const id of toRefreshIds) {
      const sourceVersionBefore = getConversationSourceVersionReadOnly(id);
      if (sourceVersionBefore === null) continue;

      replayedCount++;

      // Replay and project using canonical browser projection
      const loaded = loadConversationForProjectReadOnly(id);
      let classification: 'loaded' | 'unreadable' | 'invalid';
      let sessionRowData: {
        id: string;
        projectPath: string | null;
        sshHost: string | null;
        createdAt: string;
        updatedAt: string;
        predecessorId: string | null;
        model: string | null;
        provider: string | null;
        firstUserSnippet: string | null;
        projectedCount: number;
        skippedCount: number;
        projectionRevision: string;
      } | null = null;
      let messageRowsData: Array<{
        projectedOrdinal: number;
        originalMessageIndex: number;
        kind: string;
        originalText: string;
        normalizedText: string;
      }> = [];

      if (
        loaded.status === 'unreadable' ||
        loaded.status !== 'loaded' ||
        !loaded.conversation.createdAt ||
        loaded.conversation.id !== id
      ) {
        classification = 'unreadable';
      } else {
        const conversation = loaded.conversation;
        if (!isBrowsableSession(conversation)) {
          classification = 'invalid';
        } else {
          const projection = projectMessages(conversation);
          if (!projection) {
            classification = 'invalid';
          } else {
            classification = 'loaded';
            const updatedAt = sessionUpdatedAt(conversation);
            const revision = sessionRevision(conversation, projection);
            const firstUser = projection.records.find((r) => r.kind === 'user' && r.text);

            sessionRowData = {
              id: conversation.id,
              projectPath: conversation.projectPath ? normalizeProjectPath(conversation.projectPath) : null,
              sshHost: conversation.sshHost ? normalizeSshHost(conversation.sshHost) : null,
              createdAt: conversation.createdAt,
              updatedAt,
              predecessorId: conversation.rolloverFrom ?? null,
              model: conversation.model ?? null,
              provider: conversation.provider ?? null,
              firstUserSnippet: firstUser ? prefixSnippet(firstUser.text) : null,
              projectedCount: projection.records.length,
              skippedCount: projection.skipped,
              projectionRevision: revision,
            };

            messageRowsData = projection.records.map((r, ordinal) => ({
              projectedOrdinal: ordinal,
              originalMessageIndex: r.index,
              kind: r.kind,
              originalText: r.text,
              normalizedText: r.text.toLowerCase(),
            }));
          }
        }
      }

      // Stable publication check: ensure source did not change during replay
      const sourceVersionAfter = getConversationSourceVersionReadOnly(id);
      if (sourceVersionBefore !== sourceVersionAfter) {
        changedDuringReplay.push(id);
        continue;
      }

      // Atomic commit per session with recheck inside transaction
      const commitSessionTx = this.#db.transaction(() => {
        // Recheck: if another process already updated to this version or newer, skip
        const currentInDb = this.#db
          .prepare('SELECT source_version FROM source_inventory WHERE session_id = ?')
          .get(id) as { source_version: string } | undefined;

        if (currentInDb && currentInDb.source_version === sourceVersionAfter) {
          return;
        }

        // Clean previous session and message rows
        deleteMessageStmt.run(id);
        deleteSessionStmt.run(id);

        // Update inventory
        insertInventoryStmt.run(id, sourceVersionAfter, classification, Date.now());

        // Insert session and messages if loaded
        if (classification === 'loaded' && sessionRowData) {
          insertSessionStmt.run(
            sessionRowData.id,
            sessionRowData.projectPath,
            sessionRowData.sshHost,
            sessionRowData.createdAt,
            sessionRowData.updatedAt,
            sessionRowData.predecessorId,
            sessionRowData.model,
            sessionRowData.provider,
            sessionRowData.firstUserSnippet,
            sessionRowData.projectedCount,
            sessionRowData.skippedCount,
            sessionRowData.projectionRevision,
          );

          for (const msg of messageRowsData) {
            insertMessageStmt.run(
              id,
              msg.projectedOrdinal,
              msg.originalMessageIndex,
              msg.kind,
              msg.originalText,
              msg.normalizedText,
            );
          }
        }
      });

      commitSessionTx();
    }

    return {
      ok: true,
      replayedCount,
      deletedCount,
      stable: changedDuringReplay.length === 0,
      ...(changedDuringReplay.length > 0 ? { changedDuringReplay } : {}),
    };
  }

  list(options: { projectPath: string; sshHost?: string }): IndexedListResult {
    this.initialize();
    const normalizedProject = normalizeProjectPath(options.projectPath);
    const normalizedHost = options.sshHost ? normalizeSshHost(options.sshHost) : null;

    const rows = this.#db
      .prepare(
        `
        SELECT id, created_at, updated_at, model, provider, first_user_snippet, projected_count
        FROM sessions
        WHERE (project_path IS NOT NULL AND project_path = ?)
          AND (
            (? IS NULL AND ssh_host IS NULL)
            OR
            (ssh_host IS NOT NULL AND ssh_host = ?)
          )
        ORDER BY updated_at DESC, id ASC
      `,
      )
      .all(normalizedProject, normalizedHost, normalizedHost) as Array<{
      id: string;
      created_at: string;
      updated_at: string;
      model: string | null;
      provider: string | null;
      first_user_snippet: string | null;
      projected_count: number;
    }>;

    const unavailableRow = this.#db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM source_inventory
        WHERE classification IN ('unreadable', 'invalid')
      `,
      )
      .get() as { count: number } | undefined;

    const unavailable = unavailableRow?.count ?? 0;

    const shortRefs = uniqueConversationShortRefs(rows.map((r) => ({ id: r.id })));

    const sessions: IndexedSession[] = rows.map((r) => ({
      id: r.id,
      shortRef: shortRefs.get(r.id) ?? r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.first_user_snippet ? { firstUserMessage: r.first_user_snippet } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.provider ? { provider: r.provider } : {}),
      messageCount: r.projected_count,
    }));

    return {
      sessions,
      scope: options.projectPath,
      total: sessions.length,
      unavailable,
    };
  }

  resolveReference(
    reference: string,
    options: { projectPath: string; sshHost?: string; currentSessionId?: string },
  ): IndexedResolveResult {
    this.initialize();

    if (reference === 'previous') {
      if (!options.currentSessionId) {
        return { kind: 'not_found', message: 'This session has no persisted rollover predecessor.' };
      }
      const current = this.#db
        .prepare('SELECT predecessor_id FROM sessions WHERE id = ?')
        .get(options.currentSessionId) as { predecessor_id: string | null } | undefined;

      if (!current?.predecessor_id) {
        return { kind: 'not_found', message: 'This session has no persisted rollover predecessor.' };
      }
      return { kind: 'resolved', id: current.predecessor_id };
    }

    const normalizedProject = normalizeProjectPath(options.projectPath);
    const normalizedHost = options.sshHost ? normalizeSshHost(options.sshHost) : null;

    const rows = this.#db
      .prepare(
        `
        SELECT id
        FROM sessions
        WHERE (project_path IS NOT NULL AND project_path = ?)
          AND (
            (? IS NULL AND ssh_host IS NULL)
            OR
            (ssh_host IS NOT NULL AND ssh_host = ?)
          )
      `,
      )
      .all(normalizedProject, normalizedHost, normalizedHost) as Array<{ id: string }>;

    const resolution = resolveConversationReference(reference, rows);
    if (resolution.kind === 'ambiguous') {
      return { kind: 'ambiguous', candidates: resolution.candidates };
    }

    // Check if the resolved id exists in the scoped sessions
    const exists = rows.some((r) => r.id === resolution.id);
    if (!exists) {
      return { kind: 'not_found', message: `Session was not found in scope ${options.projectPath}.` };
    }

    return { kind: 'resolved', id: resolution.id };
  }

  getRevision(sessionId: string): string | null {
    this.initialize();
    const row = this.#db.prepare('SELECT projection_revision FROM sessions WHERE id = ?').get(sessionId) as
      | { projection_revision: string }
      | undefined;
    return row?.projection_revision ?? null;
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
