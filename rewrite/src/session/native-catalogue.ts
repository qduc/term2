/** Disposable, contentless native search index and CLI catalogue. Logs remain authoritative. */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  directLogicalEnds,
  directLogNames,
  readDirectLogHeaderLine,
  readDirectLogLineage,
  type DirectLogLineage,
} from './direct-rolling-log.js';
import { initialDirectState, reduceDirectFact, type DirectPublicState } from './direct-state.js';
import { readFactLinesFrom } from './log.js';
import type { Workspace } from '../tools/index.js';
import type { DirectBinding } from './facade-types.js';

/** The searchable documents of one lineage. The caller owns how a transcript is read (it needs the protocol layer). */
export type NativeTranscript = (lineage: DirectLogLineage) => {
  readonly documents: readonly {
    readonly id: string;
    readonly seq: number;
    readonly kind: string;
    readonly text: string;
  }[];
  readonly messageCount: number;
};

/** How the app reads a lineage for search, and how it counts the user's messages in a reduced state. */
export type NativeIndexer = {
  readonly transcript: NativeTranscript;
  readonly userMessages: (state: DirectPublicState) => number;
};

export type NativeCatalogueScope = {
  readonly target: string;
  readonly root: string | null;
  readonly binding?: DirectBinding;
};
export type NativeCatalogueEntry = {
  readonly id: string;
  readonly updated: string;
  readonly created: string;
  readonly workspace: string;
  readonly target: string;
  readonly binding: string;
  readonly model: string;
  readonly profile: string;
  readonly messages: number;
  /** Latest provider. Null on a row indexed before this column existed. */
  readonly provider: string | null;
  /** Public message count. Null on a row indexed before this column existed. */
  readonly displayed: number | null;
};
type Physical = { name: string; stamp: string; logical: string };
type Match = { rowid: number; logical: string; identity: string; seq: number; kind: string; text: string };

/** Deterministic sibling cache, outside the strict native conversation namespace. */
export function nativeCataloguePath(directory: string): string {
  return `${path.resolve(directory)}.catalogue.sqlite`;
}

function openCache(filename: string): Database.Database {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (existsSync(filename) && !lstatSync(filename).isFile()) throw new Error('Native catalogue must be a regular file');
  const open = () => {
    if (!existsSync(filename)) closeSync(openSync(filename, 'wx', 0o600));
    const db = new Database(filename);
    chmodSync(filename, 0o600);
    try {
      db.pragma('journal_mode = MEMORY');
      db.exec(`CREATE TABLE IF NOT EXISTS physical(name TEXT PRIMARY KEY, stamp TEXT NOT NULL, logical TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS catalogue(id TEXT PRIMARY KEY, updated TEXT, created TEXT, workspace TEXT, target TEXT, binding TEXT, model TEXT, profile TEXT, messages INTEGER, provider TEXT, displayed INTEGER);
        CREATE TABLE IF NOT EXISTS documents(rowid INTEGER PRIMARY KEY, logical TEXT, identity TEXT, seq INTEGER, kind TEXT, text TEXT);
        CREATE INDEX IF NOT EXISTS documents_logical ON documents(logical);
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, content='', contentless_delete=1);
        CREATE TABLE IF NOT EXISTS folds(logical TEXT PRIMARY KEY, file TEXT, ino TEXT, off INTEGER, state_seq INTEGER, seq INTEGER, docs_seq INTEGER, state TEXT);`);
      // Version 2 keeps the reduced state of each log so a grown log is read from where it was indexed.
      // An older cache has none: it is disposable, so empty it and rebuild every lineage once.
      if ((db.pragma('user_version', { simple: true }) as number) < 2) {
        db.exec(
          'DELETE FROM search; DELETE FROM documents; DELETE FROM catalogue; DELETE FROM physical; DELETE FROM folds; PRAGMA user_version = 2;',
        );
      }
      db.prepare('SELECT count(*) FROM search').get();
      const columns = new Set(
        (db.prepare('PRAGMA table_info(catalogue)').all() as { name: string }[]).map((column) => column.name),
      );
      if (!columns.has('provider')) db.exec('ALTER TABLE catalogue ADD COLUMN provider TEXT');
      if (!columns.has('displayed')) db.exec('ALTER TABLE catalogue ADD COLUMN displayed INTEGER');
      // Snippets come from the stored text, so a search never re-reads a log. An older cache has none:
      // it is disposable, so empty it and let the next refresh rebuild every lineage once.
      const documentColumns = (db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map(
        (column) => column.name,
      );
      if (!documentColumns.includes('text')) {
        db.exec(
          'ALTER TABLE documents ADD COLUMN text TEXT; DELETE FROM search; DELETE FROM documents; DELETE FROM catalogue; DELETE FROM physical;',
        );
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  try {
    return open();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(String(error.code))
    )
      throw error;
    unlinkSync(filename);
    return open();
  }
}

function allowed(entry: NativeCatalogueEntry, scope: NativeCatalogueScope, includeBound = false): boolean {
  if (entry.target !== scope.target) return false;
  const binding = JSON.parse(entry.binding || '{}') as Partial<DirectBinding>;
  if (
    !includeBound &&
    (scope.binding
      ? binding.client !== scope.binding.client || binding.id !== scope.binding.id
      : binding.client !== undefined)
  )
    return false;
  const normalize = scope.target === 'local' ? path.resolve : path.posix.normalize;
  return scope.root === null || normalize(entry.workspace) === normalize(scope.root);
}

/**
 * Open for one synchronous operation, refresh only changed logical lineages, and close.
 * Resume rows come from a stored reduced state (`folds`): a log that grew is read from the byte where it was
 * last indexed, and only a log that shrank, changed file or has no state is read whole. Search documents
 * need the full projection, so they are rebuilt, for the sessions a search may return, when its log moved.
 * `skip` leaves lineages unread: the caller already has them in memory, and rewriting their stamp would
 * hide a later refresh once they are no longer open.
 */
export function withNativeCatalogue<T>(
  directory: string,
  indexer: NativeIndexer,
  operation: (catalogue: {
    list(scope: NativeCatalogueScope, options?: { readonly includeBound?: boolean }): readonly NativeCatalogueEntry[];
    search(
      scope: NativeCatalogueScope,
      query: string,
      kind?: string,
      limit?: number,
    ): {
      total: number;
      hits: readonly { sessionId: string; identity: string; seq: number; kind: string; snippet: string }[];
    };
  }) => T,
  options?: { readonly skip?: readonly string[] },
): T {
  const skip = new Set(options?.skip ?? []);
  directory = path.resolve(directory);
  // Namespace validation must not be hidden by cache recovery or per-lineage isolation.
  const names = directLogNames(directory);
  const db = openCache(nativeCataloguePath(directory));
  try {
    db.transaction(() => {
      const previous = new Map(
        (db.prepare('SELECT * FROM physical').all() as Physical[]).map((row) => [row.name, row]),
      );
      const affected = new Set<string>();
      const indexed = new Set((db.prepare('SELECT id FROM catalogue').all() as { id: string }[]).map((row) => row.id));
      const failed = new Set<string>();
      const current: Physical[] = [];
      for (const name of names) {
        const filename = path.join(directory, name);
        const stat = lstatSync(filename, { bigint: true });
        const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
        const old = previous.get(name);
        let logical = old?.logical ?? name.slice(0, -6);
        // Older catalogues retained stamps even when indexing failed. Retry them too.
        if (old && !indexed.has(old.logical)) affected.add(old.logical);
        if (old?.stamp !== stamp) {
          if (old) affected.add(old.logical);
          try {
            const bytes = readDirectLogHeaderLine(filename);
            // A new file without a complete first line is still being created, not a corrupt Session.
            if (bytes === null && !old) continue;
            if (bytes !== null) {
              const header = JSON.parse(bytes.toString('utf8')).fact;
              if (header.type === 'session_started') logical = name.slice(0, -6);
              if (header.type === 'session_rotated' && /^conv_[0-9a-f-]{36}$/.test(header.logicalSessionId))
                logical = header.logicalSessionId;
            }
          } catch {
            /* The strict read below marks this affected lineage unavailable. */
          }
          affected.add(logical);
        }
        // An open session is already in memory. Keep the old stamp so the next
        // list, once it is closed, still refreshes this file.
        if (skip.has(logical) || (old !== undefined && skip.has(old.logical))) {
          affected.delete(logical);
          if (old) affected.delete(old.logical);
          if (old) current.push(old);
          previous.delete(name);
          continue;
        }
        current.push({ name, stamp, logical });
        previous.delete(name);
      }
      for (const removed of previous.values()) affected.add(removed.logical);
      const ends = affected.size ? directLogicalEnds(directory) : new Map();
      for (const logical of affected) {
        const end = ends.get(logical);
        if (!end) {
          dropLogical(db, logical);
          continue;
        }
        try {
          refreshColumns(db, directory, logical, end.headPath, indexer);
        } catch (error) {
          dropLogical(db, logical);
          failed.add(logical);
          console.warn(`Native catalogue unavailable for ${logical}: ${String(error)}`);
        }
      }
      db.prepare('DELETE FROM physical').run();
      const insert = db.prepare('INSERT INTO physical VALUES (?, ?, ?)');
      for (const row of current) if (!failed.has(row.logical)) insert.run(row.name, row.stamp, row.logical);
    })();
    const list = (scope: NativeCatalogueScope, listOptions?: { readonly includeBound?: boolean }) =>
      (db.prepare('SELECT * FROM catalogue ORDER BY updated DESC, id').all() as NativeCatalogueEntry[]).filter(
        (entry) => allowed(entry, scope, listOptions?.includeBound === true),
      );
    return operation({
      list,
      search(scope, query, kind, limit = 20) {
        const terms = query.trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return { total: 0, hits: [] };
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
        const authorized = new Set(list(scope).map((entry) => entry.id));
        db.transaction(() => {
          for (const logical of authorized)
            if (!skip.has(logical)) refreshDocuments(db, directory, logical, indexer.transcript);
        })();
        const rows = (
          db
            .prepare(
              `SELECT d.rowid, d.logical, d.identity, d.seq, d.kind FROM search JOIN documents d ON d.rowid = search.rowid WHERE search MATCH ? ${
                kind ? 'AND d.kind = ?' : ''
              } ORDER BY rank, d.logical, d.rowid`,
            )
            .all(...(kind ? [match, kind] : [match])) as Omit<Match, 'text'>[]
        ).filter((row) => authorized.has(row.logical));
        // Texts are large and only the returned hits need one.
        const textOf = db.prepare('SELECT text FROM documents WHERE rowid = ?');
        const hits = rows.slice(0, Math.max(1, Math.min(50, limit))).map((row) => {
          const text = (textOf.get(row.rowid) as { text: string | null } | undefined)?.text ?? '';
          const positions = terms
            .map((term) => text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()))
            .filter((position) => position >= 0);
          const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
          return {
            sessionId: row.logical,
            identity: row.identity,
            seq: row.seq,
            kind: row.kind,
            snippet: text.slice(start, start + 500),
          };
        });
        return { total: rows.length, hits };
      },
    });
  } finally {
    db.close();
  }
}

/** A grown log is read again from the stored state's offset until this much has piled up, then the state is rewritten. */
const STATE_KEEP_BYTES = 1 << 20;

type FoldRow = {
  logical: string;
  file: string;
  ino: string;
  off: number;
  state_seq: number;
  seq: number;
  docs_seq: number | null;
  state: string | null;
};

function dropLogical(db: Database.Database, logical: string): void {
  db.prepare('DELETE FROM search WHERE rowid IN (SELECT rowid FROM documents WHERE logical = ?)').run(logical);
  db.prepare('DELETE FROM documents WHERE logical = ?').run(logical);
  db.prepare('DELETE FROM catalogue WHERE id = ?').run(logical);
  db.prepare('DELETE FROM folds WHERE logical = ?').run(logical);
}

/**
 * Brings the resume columns of one lineage up to date. The reduced state is stored with the byte offset it
 * covers, so a log that only grew costs its new bytes; anything else (no state, another file, shrunk, a
 * tail that cannot be read alone) is reduced whole from the lineage.
 */
function refreshColumns(
  db: Database.Database,
  directory: string,
  logical: string,
  headPath: string,
  indexer: NativeIndexer,
): void {
  const file = path.basename(headPath);
  const stat = lstatSync(headPath, { bigint: true });
  const ino = `${stat.dev}:${stat.ino}`;
  const kept = db.prepare('SELECT * FROM folds WHERE logical = ?').get(logical) as FoldRow | undefined;
  const base = db.prepare('SELECT * FROM catalogue WHERE id = ?').get(logical) as NativeCatalogueEntry | undefined;
  let state: DirectPublicState | undefined;
  let offset = 0;
  let stateSeq = 0;
  let seq = 0;
  let updated: string | undefined;
  let save = true;
  if (kept?.state && base && kept.file === file && kept.ino === ino && BigInt(kept.off) <= stat.size) {
    try {
      const tail = readFactLinesFrom(headPath, kept.off, kept.state_seq);
      state = JSON.parse(kept.state) as DirectPublicState;
      for (const entry of tail.entries) state = reduceDirectFact(state, entry.fact, entry.seq) as DirectPublicState;
      offset = tail.complete;
      stateSeq = tail.lastSeq;
      seq = tail.lastSeq;
      // Rewriting the whole state costs more than reading a small tail again, so keep the stored one
      // until the tail it would absorb is large.
      save = tail.complete - kept.off > STATE_KEEP_BYTES;
      updated = tail.entries.at(-1)?.at ?? base.updated;
    } catch {
      state = undefined;
    }
  }
  const lineage = state ? undefined : readDirectLogLineage(directory, logical);
  if (lineage) {
    const metadata = lineage.metadata;
    let folded = initialDirectState(
      lineage.logicalSessionId,
      metadata.workspaceIdentity ?? { root: metadata.workspace, target: 'local', access: 'read' },
      metadata.model,
    );
    for (const entry of lineage.entries) folded = reduceDirectFact(folded, entry.fact, entry.seq) as DirectPublicState;
    state = folded;
    offset = lineage.segments.at(-1)!.read?.complete ?? Number(stat.size);
    seq = lineage.entries.at(-1)!.seq;
    stateSeq = seq;
    updated = lineage.entries.at(-1)!.at;
  }
  const final = state!;
  const metadata = lineage?.metadata;
  const model = final.configuration?.configuration.model ?? final.model;
  const target = metadata
    ? metadata.workspaceIdentity?.target ?? (metadata.binding?.client === 'ssh' ? '' : 'local')
    : base!.target;
  db.prepare(
    `INSERT INTO catalogue (id, updated, created, workspace, target, binding, model, profile, messages, provider, displayed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, created = excluded.created, workspace = excluded.workspace,
       target = excluded.target, binding = excluded.binding, model = excluded.model, profile = excluded.profile,
       messages = excluded.messages, provider = excluded.provider, displayed = excluded.displayed`,
  ).run(
    logical,
    updated!,
    metadata ? lineage!.entries[0]!.at : base!.created,
    metadata ? metadata.workspace : base!.workspace,
    target,
    metadata ? JSON.stringify(metadata.binding ?? {}) : base!.binding,
    model.model,
    final.configuration?.profile.id ?? metadata?.profile.id ?? base!.profile,
    indexer.userMessages(final),
    model.provider,
    final.messages.length,
  );
  // A lineage indexed for the first time keeps no state: most never change again, and writing a long session's
  // state costs more than reading its log. One that is found to have changed stores it, so its growth is read alone.
  const keep = kept !== undefined;
  if (save)
    db.prepare(
      `INSERT INTO folds (logical, file, ino, off, state_seq, seq, docs_seq, state) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(logical) DO UPDATE SET file = excluded.file, ino = excluded.ino, off = excluded.off,
         state_seq = excluded.state_seq, seq = excluded.seq, docs_seq = CASE WHEN ? THEN folds.docs_seq ELSE NULL END,
         state = excluded.state`,
    ).run(logical, file, ino, offset, stateSeq, seq, keep ? JSON.stringify(final) : null, lineage ? 0 : 1);
  else db.prepare('UPDATE folds SET seq = ? WHERE logical = ?').run(seq, logical);
}

/** Rebuilds the search documents of one lineage when its log has moved past what they were built from. */
function refreshDocuments(
  db: Database.Database,
  directory: string,
  logical: string,
  transcript: NativeTranscript,
): void {
  const fold = db.prepare('SELECT docs_seq, seq FROM folds WHERE logical = ?').get(logical) as
    | { docs_seq: number | null; seq: number }
    | undefined;
  if (!fold || fold.docs_seq === fold.seq) return;
  db.prepare('DELETE FROM search WHERE rowid IN (SELECT rowid FROM documents WHERE logical = ?)').run(logical);
  db.prepare('DELETE FROM documents WHERE logical = ?').run(logical);
  let docs: ReturnType<NativeTranscript>;
  let lastSeq: number;
  try {
    const lineage = readDirectLogLineage(directory, logical);
    docs = transcript(lineage);
    lastSeq = lineage.entries.at(-1)!.seq;
  } catch (error) {
    console.warn(`Native catalogue documents unavailable for ${logical}: ${String(error)}`);
    return;
  }
  for (const doc of docs.documents) {
    const result = db
      .prepare('INSERT INTO documents(logical, identity, seq, kind, text) VALUES (?, ?, ?, ?, ?)')
      .run(logical, doc.id, doc.seq, doc.kind, doc.text);
    db.prepare('INSERT INTO search(rowid, text) VALUES (?, ?)').run(result.lastInsertRowid, doc.text);
  }
  db.prepare('UPDATE folds SET docs_seq = ? WHERE logical = ?').run(lastSeq, logical);
}

/** Fixed authorized workspace identity, not a model-selected search path. */
export function nativeSearchScope(workspace: Workspace, binding?: DirectBinding): NativeCatalogueScope {
  return { target: workspace.target, root: workspace.root, ...(binding ? { binding } : {}) };
}
