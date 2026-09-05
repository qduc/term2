import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndexService } from './session-index-service.js';
import { createConversationLogWriter } from '../../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../conversation-persistence.js';

let tempDir = '';
let convDir = '';
let dbPath = '';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqi-service-test-'));
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

describe('SessionIndexService', () => {
  it('initializes and passes capability probe, serving list and reference resolution', async () => {
    writeSession('session-1', '/project', 'first message');
    writeSession('session-2', '/project', 'second message', 'session-1');

    const service = new SessionIndexService({
      dbPath,
      conversationsDir: convDir,
      backend: 'direct',
    });

    try {
      const ready = await service.ensureReady();
      expect(ready).toBe(true);
      expect(service.isAvailable()).toBe(true);
      expect(service.getFallbackReason()).toBeNull();

      const list = (await service.list({ projectPath: '/project' }, { limit: 10 })) as any;
      expect(list).toBeDefined();
      expect(list.total).toBe(2);
      expect(list.scope).toBe('/project');
      expect(list.sessions).toHaveLength(2);

      const resolved = await service.resolveReference('session-1', { projectPath: '/project' });
      expect(resolved).toMatchObject({ kind: 'resolved', id: 'session-1' });

      const prev = await service.resolveReference('previous', {
        projectPath: '/project',
        currentSessionId: 'session-2',
      });
      expect(prev).toMatchObject({ kind: 'resolved', id: 'session-1' });

      const rev = await service.getRevision('session-1');
      expect(typeof rev).toBe('string');
    } finally {
      await service.close();
    }
  });

  it('marks unavailable and returns null for list on capability probe failure', async () => {
    const fakeClient = {
      probe: async () => ({ ok: false as const, reason: 'FTS5 trigram unsupported' }),
      reconcile: async () => ({ ok: false, replayedCount: 0, deletedCount: 0, stable: false }),
      list: async () => ({ sessions: [], scope: '', total: 0, unavailable: 0 }),
      resolveReference: async () => ({ kind: 'not_found' as const, message: '' }),
      getRevision: async () => null,
      close: async () => {},
    } as any;

    const service = new SessionIndexService({
      dbPath,
      conversationsDir: convDir,
      workerClient: fakeClient,
    });

    const ready = await service.ensureReady();
    expect(ready).toBe(false);
    expect(service.isAvailable()).toBe(false);
    expect(service.getFallbackReason()).toBe('FTS5 trigram unsupported');

    const listResult = await service.list({ projectPath: '/project' }, {});
    expect(listResult).toBeNull();

    const resolveResult = await service.resolveReference('session-1', { projectPath: '/project' });
    expect(resolveResult).toBeNull();
  });
});
