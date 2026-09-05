import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createConversationLogWriter } from '../../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../conversation-persistence.js';
import { SessionBrowser, type SessionBrowserContext } from '../session-browser.js';
import { SessionIndexDatabase } from './session-index-database.js';
import { SessionIndexService } from './session-index-service.js';
import { SCHEMA_VERSION } from './session-index-schema.js';
import { deltaSidecarPathFor } from '../../logging/conversation-log-events.js';

let dir = '';
let dbPath = '';
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-sqi-recovery-'));
  dbPath = path.join(dir, 'recovery-test.db');
  setConversationsDirForTest(dir);
});

afterEach(() => {
  setConversationsDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSession(
  id: string,
  projectPath: string,
  sshHost?: string,
  text = 'hello',
  rolloverFrom?: string,
  model = 'test-model',
  provider = 'test-provider',
) {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    sshHost,
    model,
    provider,
    rolloverFrom,
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u`, sender: 'user', text } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: `reply for ${text}` }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

function writeSidecar(sessionId: string, text: string) {
  const sessionLogPath = path.join(dir, `${sessionId}.jsonl`);
  const sidecarPath = deltaSidecarPathFor(sessionLogPath);
  const deltaEvent =
    JSON.stringify({
      v: 3,
      seq: 99,
      ts: '2026-01-01T00:01:00.000Z',
      event: {
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text }] },
        state: { previousResponseId: null },
      },
    }) + '\n';
  fs.writeFileSync(sidecarPath, deltaEvent, 'utf-8');
}

function createV2Database(targetPath: string) {
  const db = new Database(targetPath);
  db.exec(`
    CREATE TABLE index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO index_metadata (key, value) VALUES ('schema_version', '2');
    INSERT INTO index_metadata (key, value) VALUES ('projection_version', '1');
    INSERT INTO index_metadata (key, value) VALUES ('source_directory', '${dir}');
    CREATE TABLE source_inventory (
      session_id TEXT PRIMARY KEY,
      source_version TEXT NOT NULL,
      classification TEXT NOT NULL,
      project_path TEXT,
      ssh_host TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
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
      projection_revision TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      projected_ordinal INTEGER NOT NULL,
      original_message_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      original_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_sessions_scope_updated ON sessions (project_path, ssh_host, updated_at DESC);
    CREATE INDEX idx_messages_session_ordinal ON messages (session_id, projected_ordinal ASC);
  `);
  db.prepare(
    'INSERT INTO source_inventory (session_id, source_version, classification, project_path, ssh_host, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('stale-session', '["stale_version","absent"]', 'loaded', '/project-rec', null, Date.now());
  db.close();
}

describe.each(['direct', 'worker'] as const)('SessionIndex Recovery Matrix (%s)', (backend) => {
  it('process restart: cleanly initializes pre-existing index with zero re-reconciliation and exact canonical parity', async () => {
    writeSession('session-restart-1', '/project-restart', undefined, 'quantum mechanics explanation');
    writeSession('session-restart-2', '/project-restart', undefined, 'general relativity principles');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-restart',
      currentSessionId: 'session-restart-1',
    });

    // 1. Initial process lifecycle
    const initialService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const initialBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: initialService });
    const initialList = await initialBrowser.list({ limit: 10 });
    const initialSearch = await initialBrowser.search({ query: 'quantum' });
    const initialRead = await initialBrowser.read({ id: 'session-restart-1' });

    // Close process / service
    await initialBrowser.close();
    await initialService.close();

    // 2. Restarted process lifecycle against same SQLite file
    const restartedService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const restartedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: restartedService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      // Reconcile on restart should replay 0 files
      const reconcileResult = await restartedService.reconcile();
      expect(reconcileResult).toEqual({ ok: true, replayedCount: 0, deletedCount: 0, stable: true });

      // Queries after restart match canonical exactly
      const restartedList = await restartedBrowser.list({ limit: 10 });
      const canonicalList = canonicalBrowser.list({ limit: 10 });
      expect(restartedList).toEqual(canonicalList);
      expect(restartedList).toEqual(initialList);

      const restartedSearch = await restartedBrowser.search({ query: 'quantum' });
      const canonicalSearch = canonicalBrowser.search({ query: 'quantum' });
      expect(restartedSearch).toEqual(canonicalSearch);
      expect(restartedSearch).toEqual(initialSearch);

      const restartedRead = await restartedBrowser.read({ id: 'session-restart-1' });
      const canonicalRead = canonicalBrowser.read({ id: 'session-restart-1' });
      expect(restartedRead).toEqual(canonicalRead);
      expect(restartedRead).toEqual(initialRead);
    } finally {
      await canonicalBrowser.close();
      await restartedBrowser.close();
      await restartedService.close();
    }
  });

  it('interrupted rebuild: recovers cleanly, completes rebuild with 0 orphan FTS rows and exact canonical parity', async () => {
    writeSession('session-int-1', '/project-int', undefined, 'first recoverable document');
    writeSession('session-int-2', '/project-int', undefined, 'second recoverable document');
    writeSession('session-int-3', '/project-int', undefined, 'third recoverable document');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-int',
    });

    // 1. Simulate an interrupted rebuild using SessionIndexDatabase
    const dbEngine = new SessionIndexDatabase(dbPath, dir);
    dbEngine.initialize();

    // Reconcile session-int-1 successfully
    const origPrepare = dbEngine.database.prepare.bind(dbEngine.database);
    let session2InsertCount = 0;
    (dbEngine.database as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO messages')) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: any[]) => {
          if (args[0] === 'session-int-2') {
            session2InsertCount++;
            if (session2InsertCount === 1) {
              throw new Error('Simulated process crash / power loss mid-rebuild');
            }
          }
          return origRun(...args);
        };
      }
      return stmt;
    };

    expect(() => {
      dbEngine.reconcile();
    }).toThrow('Simulated process crash / power loss mid-rebuild');
    (dbEngine.database as any).prepare = origPrepare;
    dbEngine.close();

    // 2. Recovery phase: a new service/worker opens the database and finishes rebuild
    const recoveryService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: recoveryService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      const recOutcome = await recoveryService.reconcile();
      expect(recOutcome?.ok).toBe(true);
      // It completed the uncommitted sessions
      expect(recOutcome!.replayedCount).toBeGreaterThanOrEqual(2);

      // Verify FTS5 integrity
      const inspectDb = new Database(dbPath);
      try {
        expect(() => {
          inspectDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
        }).not.toThrow();

        const msgCount = inspectDb.prepare('SELECT count(*) as c FROM messages').get() as { c: number };
        const ftsCount = inspectDb.prepare('SELECT count(*) as c FROM messages_fts').get() as { c: number };
        expect(ftsCount.c).toBe(msgCount.c);
      } finally {
        inspectDb.close();
      }

      // Parity with canonical browser
      const indList = await indexedBrowser.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(indList).toEqual(canList);

      const indSearch = await indexedBrowser.search({ query: 'recoverable' });
      const canSearch = canonicalBrowser.search({ query: 'recoverable' });
      expect(indSearch).toEqual(canSearch);
    } finally {
      await canonicalBrowser.close();
      await indexedBrowser.close();
      await recoveryService.close();
    }
  });

  it('competing refreshers: concurrent services reconcile simultaneously without corruption, matching canonical parity', async () => {
    for (let i = 1; i <= 6; i++) {
      writeSession(`session-comp-${i}`, '/project-comp', undefined, `concurrent content payload ${i}`);
    }

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-comp',
    });

    const service1 = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const service2 = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const browser1 = new SessionBrowser(getContext, { backend: 'indexed', indexService: service1 });
    const browser2 = new SessionBrowser(getContext, { backend: 'indexed', indexService: service2 });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      // Competing simultaneous reconciliations against the same SQLite database
      const [res1, res2] = await Promise.all([service1.reconcile(), service2.reconcile()]);
      expect(res1?.ok).toBe(true);
      expect(res2?.ok).toBe(true);
      expect(res1!.replayedCount + res2!.replayedCount).toBeGreaterThanOrEqual(6);

      // Both indexed browsers match canonical browser exactly
      const list1 = await browser1.list({ limit: 10 });
      const list2 = await browser2.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(list1).toEqual(canList);
      expect(list2).toEqual(canList);

      const search1 = await browser1.search({ query: 'concurrent' });
      const search2 = await browser2.search({ query: 'concurrent' });
      const canSearch = canonicalBrowser.search({ query: 'concurrent' });
      expect(search1).toEqual(canSearch);
      expect(search2).toEqual(canSearch);

      // Verify SQLite FTS5 integrity
      const inspectDb = new Database(dbPath);
      try {
        expect(() => {
          inspectDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
        }).not.toThrow();
      } finally {
        inspectDb.close();
      }
    } finally {
      await canonicalBrowser.close();
      await browser1.close();
      await browser2.close();
      await service1.close();
      await service2.close();
    }
  });

  it('schema upgrade: cleanly rebuilds outdated v2 schema without permanent fallback, achieving full parity', async () => {
    writeSession('session-up-1', '/project-up', undefined, 'schema upgrade validation text');
    writeSession('session-up-2', '/project-up', undefined, 'another upgraded conversation');

    // Manually create an outdated Schema v2 database
    createV2Database(dbPath);

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-up',
    });

    const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      // Must succeed and NOT fall back forever
      const list = await indexedBrowser.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(list).toEqual(canList);
      expect((list as any).total).toBe(2);

      const search = await indexedBrowser.search({ query: 'upgrade' });
      const canSearch = canonicalBrowser.search({ query: 'upgrade' });
      expect(search).toEqual(canSearch);
      expect((search as any).total).toBe((canSearch as any).total);

      const read = await indexedBrowser.read({ id: 'session-up-1' });
      const canRead = canonicalBrowser.read({ id: 'session-up-1' });
      expect(read).toEqual(canRead);

      // Verify the database index_metadata table now records SCHEMA_VERSION = '3'
      const inspectDb = new Database(dbPath);
      try {
        const row = inspectDb.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as {
          value: string;
        };
        expect(row.value).toBe(SCHEMA_VERSION);
        expect(() => {
          inspectDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
        }).not.toThrow();
      } finally {
        inspectDb.close();
      }
    } finally {
      await canonicalBrowser.close();
      await indexedBrowser.close();
      await indexService.close();
    }
  });

  it('source deletion and replacement: cascades deletes to FTS and updates replaced content with exact parity', async () => {
    writeSession('session-del-1', '/project-sub', undefined, 'permanent session to stay');
    writeSession('session-del-2', '/project-sub', undefined, 'temporary session to delete');
    writeSession('session-replace-3', '/project-sub', undefined, 'original unreplaced content');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-sub',
    });

    const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      await indexedBrowser.list({ limit: 10 });

      // 1. Delete session-del-2
      fs.unlinkSync(path.join(dir, 'session-del-2.jsonl'));

      // 2. Replace session-replace-3 with new content
      fs.unlinkSync(path.join(dir, 'session-replace-3.jsonl'));
      writeSession('session-replace-3', '/project-sub', undefined, 'completely updated new content');

      // 3. Reconcile
      const recResult = await indexService.reconcile();
      expect(recResult?.ok).toBe(true);
      expect(recResult?.deletedCount).toBe(1);
      expect(recResult?.replayedCount).toBe(1);

      // Verify deleted session is purged from SQLite and FTS
      const inspectDb = new Database(dbPath);
      try {
        const invDel = inspectDb
          .prepare('SELECT count(*) as c FROM source_inventory WHERE session_id = ?')
          .get('session-del-2') as { c: number };
        expect(invDel.c).toBe(0);

        const sessDel = inspectDb.prepare('SELECT count(*) as c FROM sessions WHERE id = ?').get('session-del-2') as {
          c: number;
        };
        expect(sessDel.c).toBe(0);

        const msgDel = inspectDb
          .prepare('SELECT count(*) as c FROM messages WHERE session_id = ?')
          .get('session-del-2') as { c: number };
        expect(msgDel.c).toBe(0);

        expect(() => {
          inspectDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
        }).not.toThrow();
      } finally {
        inspectDb.close();
      }

      // Parity checks for list, search, and read
      const indList = await indexedBrowser.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(indList).toEqual(canList);
      expect((indList as any).total).toBe(2);

      const indSearchOld = await indexedBrowser.search({ query: 'unreplaced' });
      expect((indSearchOld as any).total).toBe(0);

      const indSearchNew = await indexedBrowser.search({ query: 'completely updated' });
      const canSearchNew = canonicalBrowser.search({ query: 'completely updated' });
      expect(indSearchNew).toEqual(canSearchNew);
      expect((indSearchNew as any).total).toBe((canSearchNew as any).total);

      const indRead = await indexedBrowser.read({ id: 'session-replace-3' });
      const canRead = canonicalBrowser.read({ id: 'session-replace-3' });
      expect(indRead).toEqual(canRead);
    } finally {
      await canonicalBrowser.close();
      await indexedBrowser.close();
      await indexService.close();
    }
  });

  it('sidecar changes: tracks creation, modification, and removal of .deltas sidecars with exact canonical parity', async () => {
    writeSession('session-sidecar-1', '/project-side', undefined, 'base session message');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-side',
    });

    const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      // Step 1: Initial reconcile
      await indexService.reconcile();
      const read1 = await indexedBrowser.read({ id: 'session-sidecar-1' });
      const canRead1 = canonicalBrowser.read({ id: 'session-sidecar-1' });
      expect(read1).toEqual(canRead1);

      // Step 2: Create sidecar with extra delta
      writeSidecar('session-sidecar-1', 'sidecar delta message added');
      const rec2 = await indexService.reconcile();
      expect(rec2?.replayedCount).toBe(1);

      const read2 = await indexedBrowser.read({ id: 'session-sidecar-1' });
      const canRead2 = canonicalBrowser.read({ id: 'session-sidecar-1' });
      expect(read2).toEqual(canRead2);

      const search2 = await indexedBrowser.search({ query: 'sidecar delta' });
      const canSearch2 = canonicalBrowser.search({ query: 'sidecar delta' });
      expect(search2).toEqual(canSearch2);
      expect((search2 as any).total).toBe(1);

      // Step 3: Modify sidecar
      writeSidecar('session-sidecar-1', 'modified sidecar replacement payload');
      const rec3 = await indexService.reconcile();
      expect(rec3?.replayedCount).toBe(1);

      const search3Old = await indexedBrowser.search({ query: 'delta' });
      expect((search3Old as any).total).toBe(0);

      const search3New = await indexedBrowser.search({ query: 'modified sidecar' });
      const canSearch3New = canonicalBrowser.search({ query: 'modified sidecar' });
      expect(search3New).toEqual(canSearch3New);
      expect((search3New as any).total).toBe(1);

      // Step 4: Delete sidecar
      const sidecarFile = deltaSidecarPathFor(path.join(dir, 'session-sidecar-1.jsonl'));
      fs.unlinkSync(sidecarFile);
      const rec4 = await indexService.reconcile();
      expect(rec4?.replayedCount).toBe(1);

      const read4 = await indexedBrowser.read({ id: 'session-sidecar-1' });
      const canRead4 = canonicalBrowser.read({ id: 'session-sidecar-1' });
      expect(read4).toEqual(canRead4);
    } finally {
      await canonicalBrowser.close();
      await indexedBrowser.close();
      await indexService.close();
    }
  });

  it('storage failure: falls back to canonical on corrupt DB, and recovers cleanly after rebuild', async () => {
    writeSession('session-cf-1', '/project-cf', undefined, 'corrupt fallback message');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-cf',
    });

    // Write corrupt header to dbPath
    fs.writeFileSync(dbPath, 'CORRUPT_SQLITE_HEADER_GARBAGE');

    const corruptService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const fallbackBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: corruptService });

    try {
      // Browser seamlessly falls back to canonical without throwing
      const list = (await fallbackBrowser.list({ limit: 10 })) as any;
      expect(list.total).toBe(1);
      expect(list.sessions[0].id).toBe('session-cf-1');

      const search = (await fallbackBrowser.search({ query: 'corrupt' })) as any;
      expect(search.total).toBe(2);

      const read = (await fallbackBrowser.read({ id: 'session-cf-1' })) as any;
      expect(read.session.id).toBe('session-cf-1');
    } finally {
      await fallbackBrowser.close();
      await corruptService.close();
    }

    // Recovery test: delete corrupt DB file and instantiate fresh index service
    fs.unlinkSync(dbPath);

    const recoveredService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const recoveredBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: recoveredService });
    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    try {
      const list = await recoveredBrowser.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(list).toEqual(canList);

      const search = await recoveredBrowser.search({ query: 'corrupt' });
      const canSearch = canonicalBrowser.search({ query: 'corrupt' });
      expect(search).toEqual(canSearch);
    } finally {
      await canonicalBrowser.close();
      await recoveredBrowser.close();
      await recoveredService.close();
    }
  });

  it('storage failure: falls back to canonical when DB directory is read-only', async () => {
    writeSession('session-ro-1', '/project-ro', undefined, 'read-only directory test');

    const roParentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-sqi-ro-'));
    const roSubDir = path.join(roParentDir, 'ro-subdir');
    fs.mkdirSync(roSubDir);
    // Make directory read-only so SQLite cannot create database or journal files
    fs.chmodSync(roSubDir, 0o555);

    const roDbPath = path.join(roSubDir, 'readonly.db');
    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-ro',
    });

    const roService = new SessionIndexService({ conversationsDir: dir, dbPath: roDbPath, backend });
    const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService: roService });

    try {
      // Must not throw or crash; falls back to canonical browser
      const list = (await browser.list({ limit: 10 })) as any;
      expect(list.total).toBe(1);
      expect(list.sessions[0].id).toBe('session-ro-1');

      const search = (await browser.search({ query: 'read-only' })) as any;
      expect(search.total).toBe(2);

      const read = (await browser.read({ id: 'session-ro-1' })) as any;
      expect(read.session.id).toBe('session-ro-1');
    } finally {
      await browser.close();
      await roService.close();
      fs.chmodSync(roSubDir, 0o755);
      fs.rmSync(roParentDir, { recursive: true, force: true });
    }
  });

  it('storage failure: disk-full class error causes safe reconciliation failure and fallback to canonical, recovering cleanly after space restored', async () => {
    writeSession('session-df-1', '/project-df', undefined, 'initial saved session before disk full');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project-df',
    });

    const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });

    // 1. Initial successful reconcile
    const dbEngine = new SessionIndexDatabase(dbPath, dir);
    dbEngine.initialize();
    const initRec = dbEngine.reconcile();
    expect(initRec.ok).toBe(true);

    // 2. Simulate disk full by restricting max_page_count to current page count
    const pageCountRow = dbEngine.database.prepare('PRAGMA page_count').get() as { page_count: number };
    dbEngine.database.exec(`PRAGMA max_page_count = ${pageCountRow.page_count};`);

    // Add a new session with large text that requires additional pages
    writeSession('session-df-2', '/project-df', undefined, 'new session written when disk is full '.repeat(2000));

    // Attempting reconcile on full disk fails safely (throws SQLITE_FULL, rolling back transaction)
    expect(() => {
      dbEngine.reconcile();
    }).toThrow(/database or disk is full/i);

    // 3. Clear disk-full condition: restore max_page_count to default
    dbEngine.database.exec('PRAGMA max_page_count = 1073741823;');
    const recoveredRec = dbEngine.reconcile();
    expect(recoveredRec.ok).toBe(true);
    expect(recoveredRec.replayedCount).toBe(1);
    dbEngine.close();

    // 4. Now service/browser succeeds and reproduces canonical browser results
    const recoveredService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
    const recoveredBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: recoveredService });
    try {
      const recList = await recoveredBrowser.list({ limit: 10 });
      const canList = canonicalBrowser.list({ limit: 10 });
      expect(recList).toEqual(canList);

      const recSearch = await recoveredBrowser.search({ query: 'full' });
      const canSearch = canonicalBrowser.search({ query: 'full' });
      expect(recSearch).toEqual(canSearch);

      // Verify FTS integrity
      const inspectDb = new Database(dbPath);
      try {
        expect(() => {
          inspectDb.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
        }).not.toThrow();
      } finally {
        inspectDb.close();
      }
    } finally {
      await canonicalBrowser.close();
      await recoveredBrowser.close();
      await recoveredService.close();
    }
  });
});
