import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndexWorkerClient, resolveWorkerTimeoutMs } from './session-index-worker-client.js';
import { createConversationLogWriter } from '../../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../conversation-persistence.js';

let tempDir = '';
let convDir = '';
let dbPath = '';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqi-worker-test-'));
  convDir = path.join(tempDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  dbPath = path.join(tempDir, 'session-index.db');
  setConversationsDirForTest(convDir);
});

afterEach(() => {
  setConversationsDirForTest(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSession(id: string, projectPath: string, text = 'hello', rolloverFrom?: string) {
  const writer = createConversationLogWriter({ sessionId: id, dir: convDir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    model: 'model-a',
    provider: 'provider-b',
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

describe('SessionIndexWorkerClient', () => {
  it('executes capability probe, reconciliation, list, and reference resolution in worker thread', async () => {
    writeSession('session-1', '/project', 'first message');
    writeSession('session-2', '/project', 'second message', 'session-1');

    const client = new SessionIndexWorkerClient(dbPath, convDir);
    try {
      // Capability probe
      const probe = await client.probe();
      expect(probe).toEqual({ ok: true });

      // Reconcile
      const reconcileResult = await client.reconcile();
      expect(reconcileResult.ok).toBe(true);
      expect(reconcileResult.replayedCount).toBe(2);

      // List
      const list = await client.list({ projectPath: '/project' });
      expect(list.total).toBe(2);
      expect(list.sessions).toHaveLength(2);
      expect(list.sessions[0].firstUserMessage).toBeDefined();

      // Resolve reference
      const resolved = await client.resolveReference('session-1', { projectPath: '/project' });
      expect(resolved).toEqual({ kind: 'resolved', id: 'session-1', shortRef: 'session-1' });

      // Resolve 'previous'
      const previous = await client.resolveReference('previous', {
        projectPath: '/project',
        currentSessionId: 'session-2',
      });
      expect(previous).toEqual({ kind: 'resolved', id: 'session-1', shortRef: 'session-1' });

      // Revision
      const revision = await client.getRevision('session-1');
      expect(typeof revision).toBe('string');

      // Read session
      const readResult = await client.readSession('session-1', { projectPath: '/project' });
      expect(readResult.kind).toBe('loaded');
      if (readResult.kind === 'loaded') {
        expect(readResult.session.id).toBe('session-1');
        expect(readResult.session.records).toHaveLength(2);
        expect(readResult.session.records[0]).toMatchObject({
          index: 0,
          kind: 'user',
          text: 'first message',
        });
        expect(readResult.session.records[1]).toMatchObject({
          index: 1,
          kind: 'assistant',
          text: 'response',
        });
      }

      // Search
      const searchResult = await client.search({ query: 'first', projectPath: '/project' });
      expect(searchResult.matches).toHaveLength(1);
      expect(searchResult.matches[0].sessionId).toBe('session-1');
      expect(searchResult.matches[0].snippet.text).toContain('first message');
    } finally {
      await client.close();
    }
  });

  it('rejects pending calls and subsequent calls when closed', async () => {
    const client = new SessionIndexWorkerClient(dbPath, convDir);
    await client.close();

    await expect(client.probe()).rejects.toThrow('closed');
  });

  it('validates timeoutMs and TERM2_SESSION_INDEX_TIMEOUT_MS cleanly', () => {
    const origEnv = process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'];
    try {
      delete process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'];
      // Defaults to 10_000ms
      expect(resolveWorkerTimeoutMs()).toBe(10_000);
      expect(resolveWorkerTimeoutMs(undefined)).toBe(10_000);

      // Options override
      expect(resolveWorkerTimeoutMs(25_000)).toBe(25_000);

      // Invalid option values fall back to env or default
      expect(resolveWorkerTimeoutMs(0)).toBe(10_000);
      expect(resolveWorkerTimeoutMs(-500)).toBe(10_000);
      expect(resolveWorkerTimeoutMs(NaN)).toBe(10_000);

      // Environment variable valid positive number
      process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = '45000';
      expect(resolveWorkerTimeoutMs()).toBe(45_000);

      // Options take precedence over env
      expect(resolveWorkerTimeoutMs(15_000)).toBe(15_000);

      // Invalid environment variable values fall back to default
      process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = '0';
      expect(resolveWorkerTimeoutMs()).toBe(10_000);

      process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = '-1000';
      expect(resolveWorkerTimeoutMs()).toBe(10_000);

      process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = 'invalid_number';
      expect(resolveWorkerTimeoutMs()).toBe(10_000);

      process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = '   ';
      expect(resolveWorkerTimeoutMs()).toBe(10_000);
    } finally {
      if (origEnv !== undefined) {
        process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'] = origEnv;
      } else {
        delete process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'];
      }
    }
  });
});
