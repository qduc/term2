import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSchema,
  dropSchema,
  isSchemaCurrent,
  probeFts5TrigramCapability,
  writeMetadata,
  type ProbeCapabilityResult,
} from './session-index-schema.js';
import {
  loadConversationUnscopedForIndex,
  normalizeProjectPath,
  normalizeSshHost,
  resolveConversationReference,
  uniqueConversationShortRefs,
} from '../conversation-persistence.js';
import { deltaSidecarPathFor } from '../../logging/conversation-log-events.js';
import {
  isBrowsableSession,
  prefixSnippet,
  projectMessages,
  sessionRevision,
  sessionUpdatedAt,
  type Kind,
} from '../session-browser.js';
import { SNIPPET_CHARS, scoreText, termsFor } from '../session-search-helpers.js';
import { matchCenteredSnippet } from '../../../utils/output/text-snippet.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type IndexedSearchMatch = {
  sessionId: string;
  shortRef: string;
  kind: Kind;
  messageIndex: number;
  snippet: { text: string; truncated: boolean };
  updatedAt: string;
  score: number;
};

export type IndexedSearchResult = {
  matches: IndexedSearchMatch[];
  scope: string;
  unavailable: number;
  skippedMessageCount: number;
};

export type SessionIndexSearchOptions = {
  query: string;
  projectPath: string;
  sshHost?: string;
};

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
  | { kind: 'resolved'; id: string; shortRef?: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; shortRef: string }> };

export type IndexedReadRecord = {
  index: number;
  kind: Kind;
  text: string;
};

export type IndexedReadSessionData = {
  id: string;
  projectPath: string | null;
  sshHost: string | null;
  createdAt: string;
  updatedAt: string;
  predecessorId: string | null;
  model: string | null;
  provider: string | null;
  projectedCount: number;
  skippedCount: number;
  projectionRevision: string;
  sourceVersion: string;
  records: IndexedReadRecord[];
};

export type IndexedReadSessionResult =
  | { kind: 'loaded'; session: IndexedReadSessionData }
  | { kind: 'not_found' }
  | { kind: 'project_mismatch'; projectPath: string | null }
  | { kind: 'unavailable' };

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

  #statVersion(filePath: string): string | null {
    try {
      const stat = fs.statSync(filePath);
      return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch {
      return null;
    }
  }

  #getSourceVersion(id: string): string | null {
    if (!SAFE_SESSION_ID.test(id)) return null;
    const filePath = path.join(this.#sourceDirectory, `${id}.jsonl`);
    const fileVersion = this.#statVersion(filePath);
    if (!fileVersion) return null;
    const sidecarPath = deltaSidecarPathFor(filePath);
    const sidecarVersion = fs.existsSync(sidecarPath) ? this.#statVersion(sidecarPath) : 'absent';
    if (!sidecarVersion) return null;
    return JSON.stringify([fileVersion, sidecarVersion]);
  }

  initialize(): void {
    if (isSchemaCurrent(this.#db, this.#sourceDirectory)) {
      return;
    }
    const initTx = this.#db.transaction(() => {
      if (isSchemaCurrent(this.#db, this.#sourceDirectory)) {
        return;
      }
      dropSchema(this.#db);
      createSchema(this.#db);
      writeMetadata(this.#db, this.#sourceDirectory);
    });
    initTx.immediate();
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
      deleteTx.immediate(toDeleteIds);
      deletedCount = toDeleteIds.length;
    }

    // 2. Identify sessions requiring refresh
    const toRefreshIds: string[] = [];
    for (const id of liveIds) {
      const currentVersion = this.#getSourceVersion(id);
      if (currentVersion === null) continue;
      if (existingVersionMap.get(id) !== currentVersion) {
        toRefreshIds.push(id);
      }
    }

    let replayedCount = 0;
    const changedDuringReplay: string[] = [];

    // Prepared statements for insertion
    const insertInventoryStmt = this.#db.prepare(`
      INSERT INTO source_inventory (session_id, source_version, classification, project_path, ssh_host, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        source_version = excluded.source_version,
        classification = excluded.classification,
        project_path = excluded.project_path,
        ssh_host = excluded.ssh_host,
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
      const sourceVersionBefore = this.#getSourceVersion(id);
      if (sourceVersionBefore === null) continue;

      replayedCount++;

      // Replay and project using unscoped load for index
      const loaded = loadConversationUnscopedForIndex(id, this.#sourceDirectory);
      let classification: 'loaded' | 'unreadable' | 'invalid';
      let sessionProjectPath: string | null = null;
      let sessionSshHost: string | null = null;
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

      if (loaded.status !== 'loaded' || !loaded.conversation.createdAt || loaded.conversation.id !== id) {
        if (loaded.status === 'loaded' && !loaded.conversation.projectPath) {
          // A malformed/scope-less log that replayed without throwing but has no projectPath.
          // In canonical loadConversationForProjectReadOnly, project check fails and returns 'project_mismatch',
          // which canonical does NOT count in unavailable for any scope.
          // Classifying as 'invalid' with project_path = NULL ensures it is never counted dir-wide.
          classification = 'invalid';
        } else if (loaded.status === 'loaded' && loaded.conversation.projectPath) {
          // Replayed with a projectPath, but invalid id or createdAt:
          // Scoped invalid session for that specific projectPath/sshHost.
          sessionProjectPath = normalizeProjectPath(loaded.conversation.projectPath);
          if (loaded.conversation.sshHost) {
            sessionSshHost = normalizeSshHost(loaded.conversation.sshHost);
          }
          classification = 'invalid';
        } else {
          // Throwing/unreadable file on disk -> dir-wide unreadable
          classification = 'unreadable';
        }
      } else {
        const conversation = loaded.conversation;
        if (conversation.projectPath) {
          sessionProjectPath = normalizeProjectPath(conversation.projectPath);
        }
        if (conversation.sshHost) {
          sessionSshHost = normalizeSshHost(conversation.sshHost);
        }

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
              projectPath: sessionProjectPath,
              sshHost: sessionSshHost,
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
      const sourceVersionAfter = this.#getSourceVersion(id);
      if (sourceVersionBefore !== sourceVersionAfter) {
        changedDuringReplay.push(id);
        continue;
      }

      // Atomic commit per session with recheck inside transaction
      let committed = false;
      const commitSessionTx = this.#db.transaction(() => {
        // Re-STAT the source file from disk inside the serialized write transaction!
        const diskVersionInTx = this.#getSourceVersion(id);
        if (diskVersionInTx !== sourceVersionAfter) {
          // Source file was changed on disk after replay; abort stale commit!
          return;
        }

        // Recheck DB: if another process already committed this version or newer, skip
        const currentInDb = this.#db
          .prepare('SELECT source_version FROM source_inventory WHERE session_id = ?')
          .get(id) as { source_version: string } | undefined;

        if (currentInDb && currentInDb.source_version === sourceVersionAfter) {
          return;
        }

        // Clean previous session and message rows
        deleteMessageStmt.run(id);
        deleteSessionStmt.run(id);

        // Update inventory with scope info
        insertInventoryStmt.run(id, sourceVersionAfter, classification, sessionProjectPath, sessionSshHost, Date.now());

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
        committed = true;
      });

      commitSessionTx.immediate();
      if (!committed) {
        const diskVersionNow = this.#getSourceVersion(id);
        if (diskVersionNow !== sourceVersionAfter) {
          changedDuringReplay.push(id);
        }
      }
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

    // Directory-wide unreadable files (corrupt JSON lines)
    const unreadableRow = this.#db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM source_inventory
        WHERE classification = 'unreadable'
      `,
      )
      .get() as { count: number } | undefined;

    // Invalid sessions scoped to current project/SSH context
    const invalidInScopeRow = this.#db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM source_inventory
        WHERE classification = 'invalid'
          AND (project_path IS NOT NULL AND project_path = ?)
          AND (
            (? IS NULL AND ssh_host IS NULL)
            OR
            (ssh_host IS NOT NULL AND ssh_host = ?)
          )
      `,
      )
      .get(normalizedProject, normalizedHost, normalizedHost) as { count: number } | undefined;

    const unavailable = (unreadableRow?.count ?? 0) + (invalidInScopeRow?.count ?? 0);

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

    const shortRefs = uniqueConversationShortRefs(rows);

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
      return {
        kind: 'resolved',
        id: current.predecessor_id,
        shortRef: shortRefs.get(current.predecessor_id) ?? current.predecessor_id,
      };
    }

    const resolution = resolveConversationReference(reference, rows);
    if (resolution.kind === 'ambiguous') {
      return { kind: 'ambiguous', candidates: resolution.candidates };
    }

    // Check if the resolved id exists in the scoped sessions
    const exists = rows.some((r) => r.id === resolution.id);
    if (!exists) {
      return { kind: 'not_found', message: `Session was not found in scope ${options.projectPath}.` };
    }

    return {
      kind: 'resolved',
      id: resolution.id,
      shortRef: shortRefs.get(resolution.id) ?? resolution.id,
    };
  }

  readSession(sessionId: string, options: { projectPath: string; sshHost?: string }): IndexedReadSessionResult {
    this.initialize();

    const inv = this.#db
      .prepare(
        `SELECT session_id, source_version, classification, project_path, ssh_host
        FROM source_inventory
        WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          session_id: string;
          source_version: string;
          classification: 'loaded' | 'unreadable' | 'invalid';
          project_path: string | null;
          ssh_host: string | null;
        }
      | undefined;

    if (!inv) {
      return { kind: 'not_found' };
    }

    const normalizedProject = normalizeProjectPath(options.projectPath);
    const normalizedHost = options.sshHost ? normalizeSshHost(options.sshHost) : null;

    if (inv.classification === 'unreadable') {
      return { kind: 'unavailable' };
    }

    // For invalid and loaded rows, check project / SSH scope if project_path is recorded
    if (inv.project_path !== null) {
      const scopeMatches =
        inv.project_path === normalizedProject &&
        ((normalizedHost === null && inv.ssh_host === null) ||
          (normalizedHost !== null && inv.ssh_host === normalizedHost));
      if (!scopeMatches) {
        return { kind: 'project_mismatch', projectPath: inv.project_path };
      }
    } else if (inv.classification === 'invalid') {
      // Scope-less invalid file (e.g. malformed JSON with no projectPath):
      // Canonical returns project_mismatch against any requested scope.
      return { kind: 'project_mismatch', projectPath: null };
    }

    if (inv.classification === 'invalid') {
      return { kind: 'unavailable' };
    }

    const sess = this.#db
      .prepare(
        `SELECT
          id, project_path, ssh_host, created_at, updated_at, predecessor_id,
          model, provider, projected_count, skipped_count, projection_revision
        FROM sessions
        WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string;
          project_path: string | null;
          ssh_host: string | null;
          created_at: string;
          updated_at: string;
          predecessor_id: string | null;
          model: string | null;
          provider: string | null;
          projected_count: number;
          skipped_count: number;
          projection_revision: string;
        }
      | undefined;

    if (!sess) {
      return { kind: 'unavailable' };
    }

    if (sess.project_path !== null) {
      const scopeMatches =
        sess.project_path === normalizedProject &&
        ((normalizedHost === null && sess.ssh_host === null) ||
          (normalizedHost !== null && sess.ssh_host === normalizedHost));
      if (!scopeMatches) {
        return { kind: 'project_mismatch', projectPath: sess.project_path };
      }
    }

    const messageRows = this.#db
      .prepare(
        `SELECT projected_ordinal, original_message_index, kind, original_text
        FROM messages
        WHERE session_id = ?
        ORDER BY projected_ordinal ASC`,
      )
      .all(sessionId) as Array<{
      projected_ordinal: number;
      original_message_index: number;
      kind: string;
      original_text: string;
    }>;

    const records: IndexedReadRecord[] = messageRows.map((m) => ({
      index: m.original_message_index,
      kind: m.kind as Kind,
      text: m.original_text,
    }));

    return {
      kind: 'loaded',
      session: {
        id: sess.id,
        projectPath: sess.project_path,
        sshHost: sess.ssh_host,
        createdAt: sess.created_at,
        updatedAt: sess.updated_at,
        predecessorId: sess.predecessor_id,
        model: sess.model,
        provider: sess.provider,
        projectedCount: sess.projected_count,
        skippedCount: sess.skipped_count,
        projectionRevision: sess.projection_revision,
        sourceVersion: inv.source_version,
        records,
      },
    };
  }

  search(options: SessionIndexSearchOptions): IndexedSearchResult {
    this.initialize();
    const normalizedProject = normalizeProjectPath(options.projectPath);
    const normalizedHost = options.sshHost ? normalizeSshHost(options.sshHost) : null;

    // 1. Directory-wide unreadable files
    const unreadableRow = this.#db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM source_inventory
        WHERE classification = 'unreadable'
      `,
      )
      .get() as { count: number } | undefined;

    // 2. Invalid sessions scoped to current project/SSH context
    const invalidInScopeRow = this.#db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM source_inventory
        WHERE classification = 'invalid'
          AND (project_path IS NOT NULL AND project_path = ?)
          AND (
            (? IS NULL AND ssh_host IS NULL)
            OR
            (ssh_host IS NOT NULL AND ssh_host = ?)
          )
      `,
      )
      .get(normalizedProject, normalizedHost, normalizedHost) as { count: number } | undefined;

    const unavailable = (unreadableRow?.count ?? 0) + (invalidInScopeRow?.count ?? 0);

    // 3. Skipped message count for all sessions in scope
    const skippedRow = this.#db
      .prepare(
        `
        SELECT COALESCE(SUM(skipped_count), 0) as total
        FROM sessions
        WHERE (project_path IS NOT NULL AND project_path = ?)
          AND (
            (? IS NULL AND ssh_host IS NULL)
            OR
            (ssh_host IS NOT NULL AND ssh_host = ?)
          )
      `,
      )
      .get(normalizedProject, normalizedHost, normalizedHost) as { total: number } | undefined;
    const skippedMessageCount = skippedRow?.total ?? 0;

    // 4. Session rows in scope to compute shortRefs
    const sessionRows = this.#db
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
        ORDER BY updated_at DESC, id ASC
      `,
      )
      .all(normalizedProject, normalizedHost, normalizedHost) as Array<{ id: string }>;
    const shortRefs = uniqueConversationShortRefs(sessionRows);

    // 5. Parse search query into terms
    const terms = termsFor(options.query);
    if (terms.length === 0) {
      return {
        matches: [],
        scope: options.projectPath,
        unavailable,
        skippedMessageCount,
      };
    }

    // 6. Check if FTS5 trigram can be used
    const canUseFts = terms.every((t) => t.length >= 3);
    let candidateRows: Array<{
      session_id: string;
      updated_at: string;
      kind: string;
      original_message_index: number;
      original_text: string;
    }> = [];

    if (canUseFts) {
      try {
        const escapeFtsTerm = (term: string) => '"' + term.replace(/"/g, '""') + '"';
        const ftsQuery = terms.map(escapeFtsTerm).join(' OR ');

        candidateRows = this.#db
          .prepare(
            `
            SELECT m.session_id, s.updated_at, m.kind, m.original_message_index, m.original_text
            FROM messages_fts f
            JOIN messages m ON m.id = f.rowid
            JOIN sessions s ON s.id = m.session_id
            WHERE messages_fts MATCH ?
              AND (s.project_path IS NOT NULL AND s.project_path = ?)
              AND (
                (? IS NULL AND s.ssh_host IS NULL)
                OR
                (s.ssh_host IS NOT NULL AND s.ssh_host = ?)
              )
          `,
          )
          .all(ftsQuery, normalizedProject, normalizedHost, normalizedHost) as typeof candidateRows;
      } catch {
        candidateRows = this.#scopedTextCandidateQuery(terms, normalizedProject, normalizedHost);
      }
    } else {
      candidateRows = this.#scopedTextCandidateQuery(terms, normalizedProject, normalizedHost);
    }

    // 7. Exact scoring and snippet generation on top of candidates
    const matches: IndexedSearchMatch[] = [];
    for (const row of candidateRows) {
      if (!row.original_text) continue;
      const score = scoreText(row.original_text, terms);
      if (score > 0) {
        matches.push({
          sessionId: row.session_id,
          shortRef: shortRefs.get(row.session_id) ?? row.session_id,
          kind: row.kind as Kind,
          messageIndex: row.original_message_index,
          snippet: matchCenteredSnippet(row.original_text, terms, SNIPPET_CHARS),
          updatedAt: row.updated_at,
          score,
        });
      }
    }

    return {
      matches,
      scope: options.projectPath,
      unavailable,
      skippedMessageCount,
    };
  }

  #scopedTextCandidateQuery(
    terms: string[],
    normalizedProject: string,
    normalizedHost: string | null,
  ): Array<{
    session_id: string;
    updated_at: string;
    kind: string;
    original_message_index: number;
    original_text: string;
  }> {
    const instrConditions = terms.map(() => 'instr(m.normalized_text, ?) > 0').join(' OR ');
    return this.#db
      .prepare(
        `
        SELECT m.session_id, s.updated_at, m.kind, m.original_message_index, m.original_text
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE (s.project_path IS NOT NULL AND s.project_path = ?)
          AND (
            (? IS NULL AND s.ssh_host IS NULL)
            OR
            (s.ssh_host IS NOT NULL AND s.ssh_host = ?)
          )
          AND (${instrConditions})
      `,
      )
      .all(normalizedProject, normalizedHost, normalizedHost, ...terms) as Array<{
      session_id: string;
      updated_at: string;
      kind: string;
      original_message_index: number;
      original_text: string;
    }>;
  }

  explainQueryPlan(
    query: string,
    options: { projectPath: string; sshHost?: string },
  ): { strategy: 'fts5' | 'scoped_text'; plan: Array<{ id: number; parent: number; detail: string }> } {
    this.initialize();
    const normalizedProject = normalizeProjectPath(options.projectPath);
    const normalizedHost = options.sshHost ? normalizeSshHost(options.sshHost) : null;
    const terms = termsFor(query);
    const canUseFts = terms.length > 0 && terms.every((t) => t.length >= 3);

    if (canUseFts) {
      const escapeFtsTerm = (term: string) => '"' + term.replace(/"/g, '""') + '"';
      const ftsQuery = terms.map(escapeFtsTerm).join(' OR ');
      const plan = this.#db
        .prepare(
          `
          EXPLAIN QUERY PLAN
          SELECT m.session_id, s.updated_at, m.kind, m.original_message_index, m.original_text
          FROM messages_fts f
          JOIN messages m ON m.id = f.rowid
          JOIN sessions s ON s.id = m.session_id
          WHERE messages_fts MATCH ?
            AND (s.project_path IS NOT NULL AND s.project_path = ?)
            AND (
              (? IS NULL AND s.ssh_host IS NULL)
              OR
              (s.ssh_host IS NOT NULL AND s.ssh_host = ?)
            )
        `,
        )
        .all(ftsQuery, normalizedProject, normalizedHost, normalizedHost) as Array<{
        id: number;
        parent: number;
        detail: string;
      }>;
      return { strategy: 'fts5', plan };
    }

    const instrConditions =
      terms.length > 0 ? terms.map(() => 'instr(m.normalized_text, ?) > 0').join(' OR ') : '1 = 0';
    const plan = this.#db
      .prepare(
        `
        EXPLAIN QUERY PLAN
        SELECT m.session_id, s.updated_at, m.kind, m.original_message_index, m.original_text
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE (s.project_path IS NOT NULL AND s.project_path = ?)
          AND (
            (? IS NULL AND s.ssh_host IS NULL)
            OR
            (s.ssh_host IS NOT NULL AND s.ssh_host = ?)
          )
          AND (${instrConditions})
      `,
      )
      .all(normalizedProject, normalizedHost, normalizedHost, ...terms) as Array<{
      id: number;
      parent: number;
      detail: string;
    }>;
    return { strategy: 'scoped_text', plan };
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
