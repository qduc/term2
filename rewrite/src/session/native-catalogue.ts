/** Disposable, contentless native search index and CLI catalogue. Logs remain authoritative. */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  directLogNames,
  readDirectLogHeaderLine,
  readDirectLogLineage,
  type DirectLogLineage,
} from './direct-rolling-log.js';
import { latestDirectConfiguration } from './direct-configuration.js';
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
        PRAGMA user_version = 1;`);
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

/** Open for one synchronous operation, refresh only changed logical lineages, and close.
 * `skip` leaves those lineages unread: the caller already has them in memory, and
 * rewriting their stamp would hide a later refresh once they are no longer open. */
export function withNativeCatalogue<T>(
  directory: string,
  transcript: NativeTranscript,
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
      const columnFill = new Set<string>();
      const current: Physical[] = [];
      const incomplete = new Set(
        (
          db.prepare('SELECT id FROM catalogue WHERE provider IS NULL OR displayed IS NULL').all() as { id: string }[]
        ).map((row) => row.id),
      );
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
            /* Strict lineage read below marks this affected lineage unavailable. */
          }
          affected.add(logical);
        } else if (incomplete.has(logical)) columnFill.add(logical);
        // An open session is already in memory. Keep the old stamp so the next
        // list, once it is closed, still refreshes this file.
        if (skip.has(logical) || (old !== undefined && skip.has(old.logical))) {
          affected.delete(logical);
          columnFill.delete(logical);
          if (old) affected.delete(old.logical);
          if (old) current.push(old);
          previous.delete(name);
          continue;
        }
        current.push({ name, stamp, logical });
        previous.delete(name);
      }
      for (const removed of previous.values()) affected.add(removed.logical);
      for (const logical of affected) {
        db.prepare('DELETE FROM search WHERE rowid IN (SELECT rowid FROM documents WHERE logical = ?)').run(logical);
        db.prepare('DELETE FROM documents WHERE logical = ?').run(logical);
        db.prepare('DELETE FROM catalogue WHERE id = ?').run(logical);
        let lineage: ReturnType<typeof readDirectLogLineage>;
        let docs: ReturnType<NativeTranscript>;
        try {
          lineage = readDirectLogLineage(directory, logical);
          docs = transcript(lineage);
        } catch (error) {
          console.warn(`Native catalogue unavailable for ${logical}: ${String(error)}`);
          failed.add(logical);
          continue;
        }
        const configuration = latestDirectConfiguration(lineage.entries.map((entry) => entry.fact));
        const metadata = lineage.metadata;
        const model = configuration?.configuration.model ?? metadata.model;
        const target = metadata.workspaceIdentity?.target ?? (metadata.binding?.client === 'ssh' ? '' : 'local');
        db.prepare(
          'INSERT INTO catalogue (id, updated, created, workspace, target, binding, model, profile, messages, provider, displayed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          logical,
          lineage.entries.at(-1)!.at,
          lineage.entries[0]!.at,
          metadata.workspace,
          target,
          JSON.stringify(metadata.binding ?? {}),
          model.model,
          (configuration?.profile ?? metadata.profile).id,
          docs.documents.filter((doc) => doc.kind === 'user').length,
          model.provider,
          docs.messageCount,
        );
        for (const doc of docs.documents) {
          const result = db
            .prepare('INSERT INTO documents(logical, identity, seq, kind, text) VALUES (?, ?, ?, ?, ?)')
            .run(logical, doc.id, doc.seq, doc.kind, doc.text);
          db.prepare('INSERT INTO search(rowid, text) VALUES (?, ?)').run(result.lastInsertRowid, doc.text);
        }
      }
      // Same bytes as the indexed row: fill the new columns without rewriting search text.
      for (const logical of columnFill) {
        if (affected.has(logical)) continue;
        try {
          const lineage = readDirectLogLineage(directory, logical);
          const indexed = transcript(lineage);
          const configuration = latestDirectConfiguration(lineage.entries.map((entry) => entry.fact));
          const model = configuration?.configuration.model ?? lineage.metadata.model;
          db.prepare(
            'UPDATE catalogue SET provider = ?, displayed = ?, model = ?, messages = ?, updated = ? WHERE id = ?',
          ).run(
            model.provider,
            indexed.messageCount,
            model.model,
            indexed.documents.filter((doc) => doc.kind === 'user').length,
            lineage.entries.at(-1)!.at,
            logical,
          );
        } catch (error) {
          console.warn(`Native catalogue columns unavailable for ${logical}: ${String(error)}`);
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

/** Fixed authorized workspace identity, not a model-selected search path. */
export function nativeSearchScope(workspace: Workspace, binding?: DirectBinding): NativeCatalogueScope {
  return { target: workspace.target, root: workspace.root, ...(binding ? { binding } : {}) };
}
