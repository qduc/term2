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

describe('SessionBrowser Indexed Backend', () => {
  it('achieves exact result parity with canonical browser for list and read', async () => {
    writeSession('session-11111111', '/workspace/project-a', undefined, 'first question');
    writeSession('session-22222222', '/workspace/project-a', undefined, 'second question', 'session-11111111');
    writeSession('session-33333333', '/workspace/project-b', undefined, 'other project question');

    const currentSessionId: string | undefined = 'session-22222222';
    const getContext = (): SessionBrowserContext => ({
      projectPath: '/workspace/project-a',
      currentSessionId,
    });

    const indexService = new SessionIndexService({
      conversationsDir: dir,
      dbPath,
      backend: 'direct',
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

      // 4. Initial read of id1: loads id1 ONLY (1 jsonl read)
      jsonlReadCount = 0;
      const initialRead = (await indexedBrowser.read({ id: id1, limit: 1 })) as any;
      expect(initialRead.session.id).toBe(id1);
      expect(initialRead.nextCursor).toBeDefined();
      expect(jsonlReadCount).toBe(1);

      // 5. Continuation read with cursor: 0 jsonl reads, 0 rehashes (reusing cached snapshot and revision)
      const realCreateHash = crypto.createHash;
      let sha256Calls = 0;
      const hashSpy = vi.spyOn(crypto, 'createHash').mockImplementation((algo: string, options?: any) => {
        if (algo === 'sha256') sha256Calls++;
        return realCreateHash(algo, options);
      });

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
      backend: 'direct',
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
});
