import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndexDatabase } from './session-index-database.js';
import { createConversationLogWriter } from '../../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../conversation-persistence.js';
import { SessionBrowser } from '../session-browser.js';

let tempDir = '';
let convDir = '';
let dbPath = '';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqi-db-test-'));
  convDir = path.join(tempDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  dbPath = path.join(tempDir, 'session-index.db');
  setConversationsDirForTest(convDir);
});

afterEach(() => {
  setConversationsDirForTest(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSession(
  id: string,
  projectPath: string,
  sshHost?: string,
  text = 'hello',
  rolloverFrom?: string,
  model?: string,
  provider?: string,
) {
  const writer = createConversationLogWriter({ sessionId: id, dir: convDir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    sshHost,
    model: model ?? 'model-x',
    provider: provider ?? 'provider-y',
    rolloverFrom,
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u`, sender: 'user', text } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'response' }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

function appendTurn(id: string, text: string, seqStart = 4) {
  const userLine = JSON.stringify({
    v: 3,
    seq: seqStart,
    ts: '2026-01-01T00:01:00.000Z',
    event: {
      type: 'user_message',
      message: { id: `${id}-u${seqStart}`, sender: 'user', text },
    },
  });
  const assistantLine = JSON.stringify({
    v: 3,
    seq: seqStart + 1,
    ts: '2026-01-01T00:01:01.000Z',
    event: {
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: `reply for ${text}` }] },
      state: { previousResponseId: null },
    },
  });
  fs.appendFileSync(path.join(convDir, `${id}.jsonl`), `${userLine}\n${assistantLine}\n`);
}

describe('SessionIndexDatabase', () => {
  it('passes the FTS5 trigram capability probe on working better-sqlite3', () => {
    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const probe = index.probeCapability();
      expect(probe).toEqual({ ok: true });
    } finally {
      index.close();
    }
  });

  it('initializes schema v1 tables, metadata, and indexes idempotently', () => {
    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      index.initialize();
      const tables = index.database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('index_metadata');
      expect(tables).toContain('source_inventory');
      expect(tables).toContain('sessions');
      expect(tables).toContain('messages');

      const meta = index.database.prepare('SELECT key, value FROM index_metadata').all() as any[];
      const metaMap = new Map(meta.map((m) => [m.key, m.value]));
      expect(metaMap.get('schema_version')).toBe('2');
      expect(metaMap.get('projection_version')).toBe('1');
      expect(metaMap.get('source_directory')).toBe(convDir);

      // Re-initialization is idempotent
      expect(() => index.initialize()).not.toThrow();
    } finally {
      index.close();
    }
  });

  it('triggers a clean rebuild when schema_version is mismatched or outdated', () => {
    const index1 = new SessionIndexDatabase(dbPath, convDir);
    try {
      index1.initialize();
      // Manually set an outdated schema_version in metadata
      index1.database.prepare("UPDATE index_metadata SET value = '1' WHERE key = 'schema_version'").run();
      // Insert a dummy row into source_inventory
      index1.database
        .prepare(
          "INSERT INTO source_inventory (session_id, source_version, classification, updated_at) VALUES ('old', '1', 'loaded', 0)",
        )
        .run();
    } finally {
      index1.close();
    }

    // Now re-open with current database class: initialize() must detect schema mismatch, drop, and rebuild
    const index2 = new SessionIndexDatabase(dbPath, convDir);
    try {
      index2.initialize();
      const meta = index2.database.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(meta.value).toBe('2');
      // The dummy row should be dropped during rebuild
      const rowCount = index2.database.prepare('SELECT COUNT(*) as count FROM source_inventory').get() as {
        count: number;
      };
      expect(rowCount.count).toBe(0);
    } finally {
      index2.close();
    }
  });

  it('reconciles empty directory cleanly with zero sessions', () => {
    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const result = index.reconcile();
      expect(result).toEqual({ ok: true, replayedCount: 0, deletedCount: 0, stable: true });

      const list = index.list({ projectPath: '/project' });
      expect(list.sessions).toEqual([]);
      expect(list.total).toBe(0);
      expect(list.unavailable).toBe(0);
    } finally {
      index.close();
    }
  });

  it('populates sessions, messages, and inventory with exact fields and indexes', () => {
    writeSession('session-1', '/project', undefined, 'first query', undefined, 'gpt-4', 'openai');
    writeSession('session-2', '/project', 'remote-host', 'remote query');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const res = index.reconcile();
      expect(res.ok).toBe(true);
      expect(res.replayedCount).toBe(2);

      const inv = index.database.prepare('SELECT * FROM source_inventory ORDER BY session_id').all() as any[];
      expect(inv).toHaveLength(2);
      expect(inv[0].session_id).toBe('session-1');
      expect(inv[0].classification).toBe('loaded');
      expect(inv[1].session_id).toBe('session-2');
      expect(inv[1].classification).toBe('loaded');

      const sessions = index.database.prepare('SELECT * FROM sessions ORDER BY id').all() as any[];
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[0].project_path).toBe('/project');
      expect(sessions[0].ssh_host).toBeNull();
      expect(sessions[0].model).toBe('gpt-4');
      expect(sessions[0].provider).toBe('openai');
      expect(sessions[0].first_user_snippet).toBe('first query');
      expect(sessions[0].projected_count).toBe(2);
      expect(sessions[0].skipped_count).toBe(0);
      expect(typeof sessions[0].projection_revision).toBe('string');

      const messages = index.database
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY projected_ordinal')
        .all('session-1') as any[];
      expect(messages).toHaveLength(2);
      expect(messages[0].projected_ordinal).toBe(0);
      expect(messages[0].kind).toBe('user');
      expect(messages[0].original_text).toBe('first query');
      expect(messages[0].normalized_text).toBe('first query');
      expect(messages[1].projected_ordinal).toBe(1);
      expect(messages[1].kind).toBe('assistant');
      expect(messages[1].original_text).toBe('response');
    } finally {
      index.close();
    }
  });

  it('replays zero logs when directory is unchanged on subsequent reconcile', () => {
    writeSession('session-1', '/project');
    writeSession('session-2', '/project');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const first = index.reconcile();
      expect(first.replayedCount).toBe(2);

      const second = index.reconcile();
      expect(second.replayedCount).toBe(0);
      expect(second.deletedCount).toBe(0);
    } finally {
      index.close();
    }
  });

  it('refreshes only the single changed session when one file is modified', () => {
    writeSession('session-1', '/project', undefined, 'original 1');
    writeSession('session-2', '/project', undefined, 'original 2');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      expect(index.reconcile().replayedCount).toBe(2);

      // Append to session-2
      const userLine = JSON.stringify({
        v: 3,
        seq: 4,
        ts: '2026-01-01T00:01:00.000Z',
        event: {
          type: 'user_message',
          message: { id: 'session-2-u2', sender: 'user', text: 'new turn' },
        },
      });
      const assistantLine = JSON.stringify({
        v: 3,
        seq: 5,
        ts: '2026-01-01T00:01:01.000Z',
        event: {
          type: 'assistant_turn',
          turn: { items: [{ type: 'assistant_text', text: 'second response' }] },
          state: { previousResponseId: null },
        },
      });
      fs.appendFileSync(path.join(convDir, 'session-2.jsonl'), `${userLine}\n${assistantLine}\n`);

      const second = index.reconcile();
      expect(second.replayedCount).toBe(1);
      expect(second.deletedCount).toBe(0);

      const messages = index.database
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY projected_ordinal')
        .all('session-2') as any[];
      expect(messages).toHaveLength(4);
      expect(messages[2].original_text).toBe('new turn');
      expect(messages[3].original_text).toBe('second response');
    } finally {
      index.close();
    }
  });

  it('removes deleted session and cascades deletion to messages and sessions', () => {
    writeSession('session-1', '/project');
    writeSession('session-2', '/project');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      expect(index.reconcile().replayedCount).toBe(2);

      // Delete session-1 file
      fs.unlinkSync(path.join(convDir, 'session-1.jsonl'));

      const second = index.reconcile();
      expect(second.replayedCount).toBe(0);
      expect(second.deletedCount).toBe(1);

      const inv = index.database.prepare('SELECT session_id FROM source_inventory').all() as any[];
      expect(inv.map((r) => r.session_id)).toEqual(['session-2']);

      const sess = index.database.prepare('SELECT id FROM sessions').all() as any[];
      expect(sess.map((r) => r.id)).toEqual(['session-2']);

      const msgs = index.database.prepare('SELECT id FROM messages WHERE session_id = ?').all('session-1');
      expect(msgs).toHaveLength(0);
    } finally {
      index.close();
    }
  });

  it('records unreadable files in inventory without exposing guessed scope, and accounts for unavailable', () => {
    writeSession('valid-1', '/project', undefined, 'valid');

    // Create an unreadable file (e.g. a directory in place of a .jsonl file that throws EISDIR on read)
    fs.mkdirSync(path.join(convDir, 'corrupt-1.jsonl'));

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const res = index.reconcile();
      expect(res.ok).toBe(true);

      const inv = index.database.prepare('SELECT session_id, classification FROM source_inventory').all() as any[];
      const invMap = new Map(inv.map((r) => [r.session_id, r.classification]));
      expect(invMap.get('valid-1')).toBe('loaded');
      expect(invMap.get('corrupt-1')).toBe('unreadable');

      // Unreadable file must NOT have rows in sessions
      const corruptSess = index.database.prepare('SELECT * FROM sessions WHERE id = ?').get('corrupt-1');
      expect(corruptSess).toBeUndefined();

      // List query must report unavailable = 1
      const list = index.list({ projectPath: '/project' });
      expect(list.total).toBe(1);
      expect(list.sessions).toHaveLength(1);
      expect(list.unavailable).toBe(1);
    } finally {
      index.close();
    }
  });

  it('records invalid files (e.g. malformed metadata) in inventory and accounts for unavailable', () => {
    // Malformed session init with invalid non-UTC timestamp
    const line = JSON.stringify({
      v: 3,
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      event: {
        type: 'session_init',
        id: 'malformed-1',
        createdAt: 'INVALID_TIMESTAMP_FORMAT',
        projectPath: '/project',
      },
    });
    fs.writeFileSync(path.join(convDir, 'malformed-1.jsonl'), `${line}\n`);

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      index.reconcile();

      const invRow = index.database
        .prepare('SELECT classification FROM source_inventory WHERE session_id = ?')
        .get('malformed-1') as any;
      expect(invRow.classification).toBe('invalid');

      const list = index.list({ projectPath: '/project' });
      expect(list.total).toBe(0);
      expect(list.unavailable).toBe(1);
    } finally {
      index.close();
    }
  });

  it('detects mid-replay modifications and preserves stable publication', () => {
    writeSession('session-1', '/project', undefined, 'hello');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      // Modify file during replay by monkey-patching fs.readFileSync inside replay
      let intercepted = false;
      const originalRead = fs.readFileSync;
      (fs as any).readFileSync = (p: any, ...rest: any[]) => {
        const content = originalRead(p, ...rest);
        if (typeof p === 'string' && p.endsWith('session-1.jsonl') && !intercepted) {
          intercepted = true;
          // Append while reading
          fs.appendFileSync(p, '{"v":3,"seq":99,"ts":"2026-01-01T00:00:00.000Z","event":{"type":"unknown"}}\n');
        }
        return content;
      };

      try {
        const res = index.reconcile();
        expect(res.stable).toBe(false);
        expect(res.changedDuringReplay).toContain('session-1');

        // It did not commit the stale projection
        const inv = index.database.prepare('SELECT * FROM source_inventory WHERE session_id = ?').get('session-1');
        expect(inv).toBeUndefined();
      } finally {
        fs.readFileSync = originalRead;
      }
    } finally {
      index.close();
    }
  });

  it('lists sessions isolated by project and SSH scope with short references', () => {
    writeSession('11111111-0000-4000-8000-000000000001', '/project-a');
    writeSession('11111111-0000-4000-8000-000000000002', '/project-a');
    writeSession('22222222-0000-4000-8000-000000000001', '/project-b');
    writeSession('33333333-0000-4000-8000-000000000001', '/project-a', 'host-1');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      index.reconcile();

      const listA = index.list({ projectPath: '/project-a' });
      expect(listA.total).toBe(2);
      expect(listA.sessions.map((s) => s.id)).toEqual([
        '11111111-0000-4000-8000-000000000002',
        '11111111-0000-4000-8000-000000000001',
      ]);
      expect(listA.sessions[0].shortRef).toMatch(/^11111111-/);

      const listHost = index.list({ projectPath: '/project-a', sshHost: 'host-1' });
      expect(listHost.total).toBe(1);
      expect(listHost.sessions[0].id).toBe('33333333-0000-4000-8000-000000000001');

      const listB = index.list({ projectPath: '/project-b' });
      expect(listB.total).toBe(1);
      expect(listB.sessions[0].id).toBe('22222222-0000-4000-8000-000000000001');
    } finally {
      index.close();
    }
  });

  it('resolves exact, prefix, ambiguous, and previous references from indexed metadata', () => {
    const parentId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const childId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const siblingPrefixA = 'cccc1111-0000-4000-8000-000000000001';
    const siblingPrefixB = 'cccc2222-0000-4000-8000-000000000001';

    writeSession(parentId, '/project');
    writeSession(childId, '/project', undefined, 'child', parentId);
    writeSession(siblingPrefixA, '/project');
    writeSession(siblingPrefixB, '/project');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      index.reconcile();

      // Exact ID
      const exact = index.resolveReference(parentId, { projectPath: '/project' });
      expect(exact).toMatchObject({ kind: 'resolved', id: parentId });
      expect((exact as any).shortRef).toBeDefined();

      // Unique prefix
      const prefix = index.resolveReference('bbbbbbbb', { projectPath: '/project' });
      expect(prefix).toMatchObject({ kind: 'resolved', id: childId });
      expect((prefix as any).shortRef).toBeDefined();

      // Ambiguous prefix
      const ambiguous = index.resolveReference('cccc', { projectPath: '/project' });
      expect(ambiguous.kind).toBe('ambiguous');
      if (ambiguous.kind === 'ambiguous') {
        expect(ambiguous.candidates.map((c) => c.id).sort()).toEqual([siblingPrefixA, siblingPrefixB].sort());
      }

      // Previous reference
      const prev = index.resolveReference('previous', { projectPath: '/project', currentSessionId: childId });
      expect(prev).toMatchObject({ kind: 'resolved', id: parentId });

      // Previous on session with no predecessor
      const noPrev = index.resolveReference('previous', { projectPath: '/project', currentSessionId: parentId });
      expect(noPrev.kind).toBe('not_found');

      // Not found
      const notFound = index.resolveReference('nonexistent', { projectPath: '/project' });
      expect(notFound.kind).toBe('not_found');
    } finally {
      index.close();
    }
  });

  it('returns cached projection revision for session without replaying', () => {
    writeSession('session-1', '/project');
    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      index.reconcile();
      const rev = index.getRevision('session-1');
      expect(typeof rev).toBe('string');
      expect(rev!.length).toBeGreaterThan(5);

      expect(index.getRevision('nonexistent')).toBeNull();
    } finally {
      index.close();
    }
  });

  it('calculates unavailable accurately per scope (corrupt files are dir-wide, but invalid sessions are scoped)', () => {
    // 1 valid session in /project-a
    writeSession('session-valid-a', '/project-a');

    // 1 invalid session in /project-b (valid jsonl syntax but invalid timestamps so isBrowsableSession fails)
    const invalidLog = [
      JSON.stringify({
        v: 3,
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'session_init',
          id: 'session-invalid-b',
          createdAt: 'not-a-valid-iso-date',
          projectPath: '/project-b',
        },
      }),
      JSON.stringify({
        v: 3,
        seq: 2,
        ts: '2026-01-01T00:00:01.000Z',
        event: {
          type: 'user_message',
          message: { id: 'u1', sender: 'user', text: 'hello' },
        },
      }),
    ].join('\n');
    fs.writeFileSync(path.join(convDir, 'session-invalid-b.jsonl'), `${invalidLog}\n`);

    // 1 unreadable file (corrupt JSON syntax)
    fs.writeFileSync(path.join(convDir, 'corrupted-syntax.jsonl'), 'CORRUPTED_NOT_JSON\n');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      const rec = index.reconcile();
      expect(rec.ok).toBe(true);

      // Compare indexed and canonical list envelopes directly across scopes
      const canonicalBrowserA = new SessionBrowser(() => ({ projectPath: '/project-a' }), { backend: 'canonical' });
      const canonicalListA = canonicalBrowserA.list({}) as Record<string, unknown>;
      const indexedListA = index.list({ projectPath: '/project-a' });
      expect(indexedListA.total).toBe(canonicalListA['total']);
      expect(indexedListA.unavailable).toBe(canonicalListA['unavailable']);

      const canonicalBrowserB = new SessionBrowser(() => ({ projectPath: '/project-b' }), { backend: 'canonical' });
      const canonicalListB = canonicalBrowserB.list({}) as Record<string, unknown>;
      const indexedListB = index.list({ projectPath: '/project-b' });
      expect(indexedListB.total).toBe(canonicalListB['total']);
      expect(indexedListB.unavailable).toBe(canonicalListB['unavailable']);
    } finally {
      index.close();
    }
  });

  it('prevents stale replay from overwriting newer version committed by another process', async () => {
    writeSession('session-stale', '/project', undefined, 'turn 1');

    const index1 = new SessionIndexDatabase(dbPath, convDir);
    const index2 = new SessionIndexDatabase(dbPath, convDir);
    try {
      // Step 1: index1 does initial reconcile (indexes turn 1)
      const initRes = index1.reconcile();
      expect(initRes.ok).toBe(true);

      // Step 2: Append turn 1.5 to session-stale so index1 has something to replay
      appendTurn('session-stale', 'turn 1.5', 4);

      // Step 3: Set up spy on index1 database transaction.
      // In reconcile(), commitSessionTx is created with db.transaction(() => { ... }) (fn.length === 0).
      // Right before commitSessionTx.immediate() begins its write transaction,
      // index2 commits a NEWER version (turn 2) to disk and database.
      let injected = false;
      const origTransaction = index1.database.transaction.bind(index1.database);
      vi.spyOn(index1.database, 'transaction').mockImplementation((fn: any) => {
        const tx = origTransaction(fn);
        if (fn.length === 0) {
          const wrapper = (...args: any[]) => tx(...args);
          wrapper.immediate = (...args: any[]) => {
            if (!injected) {
              injected = true;
              // Process 2 appends turn 2 to the source file on disk
              appendTurn('session-stale', 'turn 2', 6);

              // Process 2 reconciles and commits the newer version to the database BEFORE index1 transaction begins
              const res2 = index2.reconcile();
              expect(res2.ok).toBe(true);
            }
            return tx.immediate(...args);
          };
          wrapper.deferred = (...args: any[]) => tx.deferred(...args);
          wrapper.exclusive = (...args: any[]) => tx.exclusive(...args);
          return wrapper as any;
        }
        return tx;
      });

      // Run index1's reconcile. Inside commitSessionTx, index1 re-stats the file from disk
      // and detects that diskVersionInTx !== sourceVersionAfter (the disk version changed
      // after index1's replay). It aborts the commit and skips overwriting.
      const res1 = index1.reconcile();
      expect(res1.ok).toBe(true);
      expect(res1.stable).toBe(false);

      // Verify that database reflects the newer version from index2 (3 turns = 6 messages),
      // NOT the stale replay from index1 (2 turns = 4 messages).
      const sessRow = index2.database
        .prepare('SELECT projected_count FROM sessions WHERE id = ?')
        .get('session-stale') as { projected_count: number };
      expect(sessRow.projected_count).toBe(6);
    } finally {
      vi.restoreAllMocks();
      index1.close();
      index2.close();
    }
  });

  it('recovers cleanly when interrupted between replay and commit with no orphan rows', () => {
    writeSession('session-interrupt', '/project', undefined, 'turn 1');

    const index = new SessionIndexDatabase(dbPath, convDir);
    try {
      // Reconcile initial state
      index.reconcile();

      // Append new turn to disk
      appendTurn('session-interrupt', 'interrupted turn', 4);

      // Simulate an error thrown inside the commit transaction (e.g. unexpected failure or crash)
      let failedOnce = false;
      const origPrepare = index.database.prepare.bind(index.database);
      vi.spyOn(index.database, 'prepare').mockImplementation((sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes('INSERT INTO sessions')) {
          return new Proxy(stmt, {
            get(target, prop, receiver) {
              if (prop === 'run' && !failedOnce) {
                return () => {
                  failedOnce = true;
                  throw new Error('Simulated crash between replay and commit');
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return stmt;
      });

      expect(() => index.reconcile()).toThrow('Simulated crash between replay and commit');

      // The transaction was rolled back, so there are no orphan rows or corrupt partial writes
      const msgCount = index.database
        .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
        .get('session-interrupt') as { count: number };
      expect(msgCount.count).toBe(2); // Still original 2 messages, not orphaned

      vi.restoreAllMocks();

      // Subsequent reconcile succeeds cleanly
      const recovery = index.reconcile();
      expect(recovery.ok).toBe(true);
      const msgCountAfter = index.database
        .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
        .get('session-interrupt') as { count: number };
      expect(msgCountAfter.count).toBe(4); // Now 4 messages
    } finally {
      vi.restoreAllMocks();
      index.close();
    }
  });
});
