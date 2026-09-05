import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from './conversation-persistence.js';
import { SessionBrowser, type SessionBrowserContext } from './session-browser.js';
import { SessionIndexService } from './session-index/session-index-service.js';

let dir = '';
let dbPath = '';
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-indexed-browser-'));
  dbPath = path.join(dir, 'test-index.db');
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

function writeComplexSession(id: string, projectPath: string, rolloverFrom?: string) {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    model: 'test-model',
    provider: 'test-provider',
    rolloverFrom,
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u1`, sender: 'user', text: 'turn 1' } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'assistant reply 1' }] },
    state: { previousResponseId: null },
  });
  const oversized = `Start of large message. 😀🚀 ${'chunk_payload_data '.repeat(120)} End of large message.`;
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: oversized }] },
    state: { previousResponseId: null },
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u2`, sender: 'user', text: 'turn 2' } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'final reply' }] },
    state: { previousResponseId: null },
  });
  void writer.close();
  return { oversized };
}

describe('SessionBrowser Indexed Backend', () => {
  describe.each(['direct', 'worker'] as const)('acceptance parity across backend (%s)', (backend) => {
    it('achieves exact result parity with canonical browser for list and read', async () => {
      writeSession('session-11111111', '/workspace/project-a', undefined, 'first question');
      writeSession('session-22222222', '/workspace/project-a', undefined, 'second question', 'session-11111111');
      writeSession('session-33333333', '/workspace/project-b', undefined, 'other project question');

      // Add malformed scope-less log, invalid sessions, and unreadable file to verify differential list parity
      fs.writeFileSync(path.join(dir, 'corrupt-malformed.jsonl'), 'CORRUPTED_NOT_JSON\n');
      fs.writeFileSync(
        path.join(dir, 'invalid-other-scope.jsonl'),
        JSON.stringify({
          v: 3,
          seq: 1,
          ts: '2026-01-01T00:00:00.000Z',
          event: {
            type: 'session_init',
            id: 'invalid-other-scope',
            createdAt: 'invalid-date',
            projectPath: '/workspace/project-b',
          },
        }) + '\n',
      );
      fs.writeFileSync(
        path.join(dir, 'invalid-in-scope.jsonl'),
        JSON.stringify({
          v: 3,
          seq: 1,
          ts: '2026-01-01T00:00:00.000Z',
          event: {
            type: 'session_init',
            id: 'invalid-in-scope',
            createdAt: 'invalid-date',
            projectPath: '/workspace/project-a',
          },
        }) + '\n',
      );
      fs.mkdirSync(path.join(dir, 'unreadable-file.jsonl'));

      const currentSessionId: string | undefined = 'session-22222222';
      const getContext = (): SessionBrowserContext => ({
        projectPath: '/workspace/project-a',
        currentSessionId,
      });

      const indexService = new SessionIndexService({
        conversationsDir: dir,
        dbPath,
        backend,
      });

      const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });
      const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

      try {
        // 1. Parity for list
        const canonicalList = canonicalBrowser.list({ limit: 10 }) as Record<string, unknown>;
        const indexedList = (await indexedBrowser.list({ limit: 10 })) as Record<string, unknown>;
        expect(indexedList).toEqual(canonicalList);

        // 2. Parity for exact read
        const canonicalReadExact = canonicalBrowser.read({ id: 'session-11111111' });
        const indexedReadExact = await indexedBrowser.read({ id: 'session-11111111' });
        expect(indexedReadExact).toEqual(canonicalReadExact);

        // 3. Parity for prefix read
        const canonicalReadPrefix = canonicalBrowser.read({ id: 'session-11' });
        const indexedReadPrefix = await indexedBrowser.read({ id: 'session-11' });
        expect(indexedReadPrefix).toEqual(canonicalReadPrefix);

        // 4. Parity for previous read (rollover predecessor)
        const canonicalReadPrev = canonicalBrowser.read({ id: 'previous' });
        const indexedReadPrev = await indexedBrowser.read({ id: 'previous' });
        expect(indexedReadPrev).toEqual(canonicalReadPrev);

        // 5. Parity for ambiguous reference
        const canonicalReadAmbiguous = canonicalBrowser.read({ id: 'session' });
        const indexedReadAmbiguous = await indexedBrowser.read({ id: 'session' });
        expect(indexedReadAmbiguous).toEqual(canonicalReadAmbiguous);

        // 6. Parity for not-found reference
        const canonicalReadNotFound = canonicalBrowser.read({ id: 'session-99999999' });
        const indexedReadNotFound = await indexedBrowser.read({ id: 'session-99999999' });
        expect(indexedReadNotFound).toEqual(canonicalReadNotFound);

        // 7. Parity for from: "end"
        const canonicalReadEnd = canonicalBrowser.read({ id: 'session-11111111', from: 'end', limit: 1 });
        const indexedReadEnd = await indexedBrowser.read({ id: 'session-11111111', from: 'end', limit: 1 });
        // Clear cursor for structural check since cursor IDs increment independently
        const stripCursor = (obj: any) => {
          const copy = { ...obj };
          delete copy.nextCursor;
          return copy;
        };
        expect(stripCursor(indexedReadEnd)).toEqual(stripCursor(canonicalReadEnd));
      } finally {
        await indexedBrowser.close();
        await indexService.close();
      }
    });
  });

  // Direct backend is used because fs.readFileSync and crypto.createHash spies cannot observe calls across the worker thread boundary.
  it('replays zero logs on unchanged list and reference resolution, and zero rehash on continuations', async () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '11111111-2222-4222-8222-222222222222';
    writeSession(id1, '/project', undefined, 'alpha question');
    writeSession(id2, '/project', undefined, 'beta question');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project',
      currentSessionId: id2,
    });

    const indexService = new SessionIndexService({
      conversationsDir: dir,
      dbPath,
      backend: 'direct',
    });

    const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

    try {
      // Warm up / initial reconcile
      await indexedBrowser.list({ limit: 10 });

      // Track readFileSync calls on .jsonl files
      const realReadFileSync = fs.readFileSync;
      let jsonlReadCount = 0;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((targetPath: any, options: any) => {
        if (typeof targetPath === 'string' && targetPath.endsWith('.jsonl')) {
          jsonlReadCount++;
        }
        return realReadFileSync(targetPath, options);
      });

      // 1. List on unchanged directory: 0 jsonl reads
      jsonlReadCount = 0;
      const listRes = (await indexedBrowser.list({ limit: 10 })) as Record<string, unknown>;
      expect(listRes.total).toBe(2);
      expect(jsonlReadCount).toBe(0);

      // 2. Reference resolution for ambiguous reference: 0 jsonl reads
      jsonlReadCount = 0;
      const ambigRes = (await indexedBrowser.read({ id: '11111111' })) as Record<string, unknown>;
      expect((ambigRes as any).error.code).toBe('ambiguous_reference');
      expect(jsonlReadCount).toBe(0);

      // 3. Reference resolution for not-found reference: 0 jsonl reads
      jsonlReadCount = 0;
      const notFoundRes = (await indexedBrowser.read({ id: '99999999-9999-4999-8999-999999999999' })) as Record<
        string,
        unknown
      >;
      expect((notFoundRes as any).error.code).toBe('not_found');
      expect(jsonlReadCount).toBe(0);

      // 4. Initial read of id1: served directly from messages table (0 jsonl reads, 0 rehashes)
      const realCreateHash = crypto.createHash;
      let sha256Calls = 0;
      const hashSpy = vi.spyOn(crypto, 'createHash').mockImplementation((algo: string, options?: any) => {
        if (algo === 'sha256') sha256Calls++;
        return realCreateHash(algo, options);
      });

      jsonlReadCount = 0;
      sha256Calls = 0;
      const initialRead = (await indexedBrowser.read({ id: id1, limit: 1 })) as any;
      expect(initialRead.session.id).toBe(id1);
      expect(initialRead.nextCursor).toBeDefined();
      expect(jsonlReadCount).toBe(0);
      expect(sha256Calls).toBe(0);

      // 5. Continuation read with cursor: 0 jsonl reads, 0 rehashes (reusing cached snapshot and revision)
      jsonlReadCount = 0;
      sha256Calls = 0;
      const contRead = (await indexedBrowser.read({
        id: id1,
        cursor: initialRead.nextCursor,
      })) as any;
      expect(contRead.session.id).toBe(id1);
      expect(jsonlReadCount).toBe(0);
      expect(sha256Calls).toBe(0);

      readSpy.mockRestore();
      hashSpy.mockRestore();
    } finally {
      await indexedBrowser.close();
      await indexService.close();
    }
  });

  it('refreshes only the single changed session when a source is appended', async () => {
    writeSession('session-1', '/project', undefined, 'msg 1');
    writeSession('session-2', '/project', undefined, 'msg 2');

    const indexService = new SessionIndexService({
      conversationsDir: dir,
      dbPath,
      backend: 'direct',
    });

    try {
      // First reconciliation indexes both sessions
      const res1 = await indexService.reconcile();
      expect(res1.ok).toBe(true);
      expect(res1.replayedCount).toBe(2);

      // Second reconciliation on unchanged directory: 0 replayed
      const res2 = await indexService.reconcile();
      expect(res2.ok).toBe(true);
      expect(res2.replayedCount).toBe(0);

      // Append to session-2 only
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
      fs.appendFileSync(path.join(dir, 'session-2.jsonl'), `${userLine}\n${assistantLine}\n`);

      // Third reconciliation: exactly 1 session replayed!
      const res3 = await indexService.reconcile();
      expect(res3.ok).toBe(true);
      expect(res3.replayedCount).toBe(1);
    } finally {
      await indexService.close();
    }
  });

  describe.each(['direct', 'worker'] as const)('fallback to canonical (%s backend)', (backend) => {
    it('falls back seamlessly to canonical browser when index is corrupt or unavailable', async () => {
      writeSession('session-fallback', '/project', undefined, 'fallback test msg');

      const getContext = (): SessionBrowserContext => ({
        projectPath: '/project',
      });

      // Write a corrupt file at dbPath
      fs.writeFileSync(dbPath, 'CORRUPT_SQLITE_HEADER_GARBAGE');

      const indexService = new SessionIndexService({
        conversationsDir: dir,
        dbPath,
        backend,
      });

      const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

      try {
        // list falls back to canonical without throwing!
        const list = (await browser.list({ limit: 10 })) as any;
        expect(list.total).toBe(1);
        expect(list.sessions[0].id).toBe('session-fallback');

        // read falls back to canonical without throwing!
        const read = (await browser.read({ id: 'session-fallback' })) as any;
        expect(read.session.id).toBe('session-fallback');
      } finally {
        await browser.close();
        await indexService.close();
      }
    });
  });

  it('works with the worker thread client across asynchronous boundaries', async () => {
    writeSession('session-worker-1', '/project', undefined, 'worker test msg 1');
    writeSession('session-worker-2', '/project', undefined, 'worker test msg 2');

    const getContext = (): SessionBrowserContext => ({
      projectPath: '/project',
      currentSessionId: 'session-worker-2',
    });

    const indexService = new SessionIndexService({
      conversationsDir: dir,
      dbPath,
      backend: 'worker',
    });

    const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

    try {
      const list = (await browser.list({ limit: 10 })) as any;
      expect(list.total).toBe(2);
      expect(list.sessions).toHaveLength(2);

      const read = (await browser.read({ id: 'session-worker-1' })) as any;
      expect(read.session.id).toBe('session-worker-1');
      expect(read.items).toHaveLength(2);
    } finally {
      await browser.close();
      await indexService.close();
    }
  });

  describe.each(['direct', 'worker'] as const)(
    'complete forward and tail page walks matching canonical (%s backend)',
    (backend) => {
      it('reproduces complete forward page walk with chunked oversized records', async () => {
        const id = `session-complex-forward-${backend}`;
        const { oversized } = writeComplexSession(id, '/project');

        const getContext = (): SessionBrowserContext => ({ projectPath: '/project' });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });
        const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          // Walk canonical
          const canonicalPages: any[] = [];
          let curCanonical: any = canonicalBrowser.read({ id, maxChars: 800, limit: 2 });
          canonicalPages.push(curCanonical);
          while (curCanonical.nextCursor) {
            curCanonical = canonicalBrowser.read({ id, cursor: curCanonical.nextCursor, maxChars: 800, limit: 2 });
            canonicalPages.push(curCanonical);
          }

          // Walk indexed
          const indexedPages: any[] = [];
          let curIndexed: any = await indexedBrowser.read({ id, maxChars: 800, limit: 2 });
          indexedPages.push(curIndexed);
          while (curIndexed.nextCursor) {
            curIndexed = await indexedBrowser.read({ id, cursor: curIndexed.nextCursor, maxChars: 800, limit: 2 });
            indexedPages.push(curIndexed);
          }

          // Both walks must produce the same number of pages (> 1 due to chunking)
          expect(indexedPages.length).toBeGreaterThan(1);
          expect(indexedPages.length).toBe(canonicalPages.length);

          // Page-by-page comparison
          for (let i = 0; i < canonicalPages.length; i++) {
            const cPage = canonicalPages[i];
            const iPage = indexedPages[i];

            expect(iPage.scope).toBe(cPage.scope);
            expect(iPage.total).toBe(cPage.total);
            expect(iPage.omitted).toBe(cPage.omitted);
            expect(iPage.skippedMessageCount).toBe(cPage.skippedMessageCount);
            expect(Boolean(iPage.nextCursor)).toBe(Boolean(cPage.nextCursor));
            expect(iPage.items).toEqual(cPage.items);
            // Invariant: total - omitted === items.length
            expect(iPage.total - iPage.omitted).toBe(iPage.items.length);
          }

          // Reconstructed chunked text must match original
          const chunkedItems = indexedPages.flatMap((p) => p.items).filter((item: any) => item.index === 2);
          const reconstructed = chunkedItems.map((item: any) => item.text).join('');
          expect(reconstructed).toBe(oversized);
        } finally {
          await indexedBrowser.close();
          await canonicalBrowser.close();
          await indexService.close();
        }
      });

      it('reproduces complete tail page walk with from: "end" and continuation', async () => {
        const id = `session-complex-tail-${backend}`;
        writeComplexSession(id, '/project');

        const getContext = (): SessionBrowserContext => ({ projectPath: '/project' });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const canonicalBrowser = new SessionBrowser(getContext, { backend: 'canonical' });
        const indexedBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          // Walk canonical tail
          const canonicalPages: any[] = [];
          let curCanonical: any = canonicalBrowser.read({ id, from: 'end', limit: 4, maxChars: 600 });
          canonicalPages.push(curCanonical);
          while (curCanonical.nextCursor) {
            curCanonical = canonicalBrowser.read({ id, cursor: curCanonical.nextCursor, limit: 4, maxChars: 600 });
            canonicalPages.push(curCanonical);
          }

          // Walk indexed tail
          const indexedPages: any[] = [];
          let curIndexed: any = await indexedBrowser.read({ id, from: 'end', limit: 4, maxChars: 600 });
          indexedPages.push(curIndexed);
          while (curIndexed.nextCursor) {
            curIndexed = await indexedBrowser.read({ id, cursor: curIndexed.nextCursor, limit: 4, maxChars: 600 });
            indexedPages.push(curIndexed);
          }

          expect(indexedPages.length).toBeGreaterThan(1);
          expect(indexedPages.length).toBe(canonicalPages.length);

          for (let i = 0; i < canonicalPages.length; i++) {
            const cPage = canonicalPages[i];
            const iPage = indexedPages[i];

            expect(iPage.scope).toBe(cPage.scope);
            expect(iPage.total).toBe(cPage.total);
            expect(iPage.omitted).toBe(cPage.omitted);
            expect(iPage.skippedMessageCount).toBe(cPage.skippedMessageCount);
            expect(Boolean(iPage.nextCursor)).toBe(Boolean(cPage.nextCursor));
            expect(iPage.items).toEqual(cPage.items);
            expect(iPage.total - iPage.omitted).toBe(iPage.items.length);
          }
        } finally {
          await indexedBrowser.close();
          await canonicalBrowser.close();
          await indexService.close();
        }
      });
    },
  );

  describe.each(['direct', 'worker'] as const)(
    'cursor outcomes on source, scope, predecessor, revision, and position changes (%s backend)',
    (backend) => {
      it('returns stale_cursor when source is modified on disk', async () => {
        const id = `session-cursor-stale-source-${backend}`;
        writeSession(id, '/project', undefined, 'initial message');

        const getContext = (): SessionBrowserContext => ({ projectPath: '/project' });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          const initial = (await browser.read({ id, limit: 1 })) as any;
          expect(initial.nextCursor).toBeDefined();

          // Append to source file to change source version
          const userLine = JSON.stringify({
            v: 3,
            seq: 4,
            ts: '2026-01-01T00:05:00.000Z',
            event: { type: 'user_message', message: { id: `${id}-u2`, sender: 'user', text: 'append' } },
          });
          fs.appendFileSync(path.join(dir, `${id}.jsonl`), `${userLine}\n`);

          // Continuation read must return stale_cursor
          const cont = (await browser.read({ id, cursor: initial.nextCursor })) as any;
          expect(cont.error?.code).toBe('stale_cursor');
        } finally {
          await browser.close();
          await indexService.close();
        }
      });

      it('returns not_found when scope is changed between initial read and continuation', async () => {
        const id = `session-cursor-scope-change-${backend}`;
        writeSession(id, '/project-alpha', undefined, 'message alpha');

        let currentProject = '/project-alpha';
        const getContext = (): SessionBrowserContext => ({ projectPath: currentProject });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          const initial = (await browser.read({ id, limit: 1 })) as any;
          expect(initial.nextCursor).toBeDefined();

          // Switch context to project-beta
          currentProject = '/project-beta';

          const cont = (await browser.read({ id, cursor: initial.nextCursor })) as any;
          expect(cont.error?.code).toBe('not_found');
        } finally {
          await browser.close();
          await indexService.close();
        }
      });

      it('returns stale_cursor when previous dependency changes', async () => {
        const id1 = `session-cursor-pred-1-${backend}`;
        const id2 = `session-cursor-pred-2-${backend}`;
        writeSession(id1, '/project', undefined, 'first');
        writeSession(id2, '/project', undefined, 'second', id1);

        const getContext = (): SessionBrowserContext => ({ projectPath: '/project', currentSessionId: id2 });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          const initial = (await browser.read({ id: 'previous', limit: 1 })) as any;
          expect(initial.nextCursor).toBeDefined();
          expect(initial.session.id).toBe(id1);

          // Mutate the predecessor source on disk
          const appendLine = JSON.stringify({
            v: 3,
            seq: 4,
            ts: '2026-01-01T00:05:00.000Z',
            event: { type: 'user_message', message: { id: `${id1}-new`, sender: 'user', text: 'new msg' } },
          });
          fs.appendFileSync(path.join(dir, `${id1}.jsonl`), `${appendLine}\n`);

          const cont = (await browser.read({ id: 'previous', cursor: initial.nextCursor })) as any;
          expect(cont.error?.code).toBe('stale_cursor');
        } finally {
          await browser.close();
          await indexService.close();
        }
      });

      it('returns invalid_cursor for unknown handle or invalid from: "end" with cursor', async () => {
        const id = `session-cursor-invalid-${backend}`;
        writeSession(id, '/project', undefined, 'msg');

        const getContext = (): SessionBrowserContext => ({ projectPath: '/project' });
        const indexService = new SessionIndexService({ conversationsDir: dir, dbPath, backend });
        const browser = new SessionBrowser(getContext, { backend: 'indexed', indexService });

        try {
          const unknownCursor = (await browser.read({ id, cursor: 'c999999' })) as any;
          expect(unknownCursor.error?.code).toBe('invalid_cursor');

          const fromEndWithCursor = (await browser.read({ id, from: 'end', cursor: 'c0' })) as any;
          expect(fromEndWithCursor.error?.code).toBe('invalid_cursor');
        } finally {
          await browser.close();
          await indexService.close();
        }
      });
    },
  );

  it('replays zero logs and zero hashes on initial read and continuations after restart with existing index', async () => {
    const id = 'session-restart-zero-replay';
    writeSession(id, '/project', undefined, 'session before restart');

    // Build the index initially
    const initService = new SessionIndexService({ conversationsDir: dir, dbPath, backend: 'direct' });
    const res = await initService.reconcile();
    expect(res.ok).toBe(true);
    expect(res.replayedCount).toBe(1);
    await initService.close();

    // Now simulate restart: create completely fresh SessionIndexService and SessionBrowser instances
    const restartService = new SessionIndexService({ conversationsDir: dir, dbPath, backend: 'direct' });
    const getContext = (): SessionBrowserContext => ({ projectPath: '/project' });
    const restartBrowser = new SessionBrowser(getContext, { backend: 'indexed', indexService: restartService });

    const realReadFileSync = fs.readFileSync;
    let jsonlReadCount = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, options: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('.jsonl')) {
        jsonlReadCount++;
      }
      return realReadFileSync(filePath, options);
    });

    const realCreateHash = crypto.createHash;
    let sha256Calls = 0;
    const hashSpy = vi.spyOn(crypto, 'createHash').mockImplementation((algo: string, options?: any) => {
      if (algo === 'sha256') sha256Calls++;
      return realCreateHash(algo, options);
    });

    try {
      // Initial read after restart: must NOT read any .jsonl files and must NOT call sha256!
      jsonlReadCount = 0;
      sha256Calls = 0;
      const initial = (await restartBrowser.read({ id, limit: 1 })) as any;
      expect(initial.session.id).toBe(id);
      expect(initial.nextCursor).toBeDefined();
      expect(jsonlReadCount).toBe(0);
      expect(sha256Calls).toBe(0);

      // Continuation read: must also NOT read .jsonl and NOT call sha256!
      jsonlReadCount = 0;
      sha256Calls = 0;
      const cont = (await restartBrowser.read({ id, cursor: initial.nextCursor })) as any;
      expect(cont.session.id).toBe(id);
      expect(jsonlReadCount).toBe(0);
      expect(sha256Calls).toBe(0);
    } finally {
      readSpy.mockRestore();
      hashSpy.mockRestore();
      await restartBrowser.close();
      await restartService.close();
    }
  });
});
