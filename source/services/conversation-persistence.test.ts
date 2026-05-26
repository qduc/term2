import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter, LockConflictError } from './conversation-log-writer.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';

let testDir = '';

function cleanupAll() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

const stubLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  getCorrelationId: () => undefined,
} as any;

function emptySnapshot(): StateSnapshot {
  return { history: [], previousResponseId: null, toolLedger: [] };
}

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-conversations-test-'));
  persistenceModule.setConversationsDirForTest(testDir);
});
test.afterEach.always(cleanupAll);
test.afterEach.always(() => {
  persistenceModule.setConversationsDirForTest(null);
  testDir = '';
});

test.serial('generateId: returns a valid UUID', (t) => {
  const id = persistenceModule.generateId();
  t.regex(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test.serial('generateId: returns unique IDs', (t) => {
  t.not(persistenceModule.generateId(), persistenceModule.generateId());
});

test.serial('getResumeCommand: returns correct format', (t) => {
  const id = 'test-uuid-123';
  t.is(persistenceModule.getResumeCommand(id), 'term2 --resume test-uuid-123');
  t.is(persistenceModule.getResumeCommand(id, 'user@host'), 'term2 --ssh user@host --resume test-uuid-123');
  t.is(
    persistenceModule.getResumeCommand(id, 'user@host', '/path'),
    'term2 --ssh user@host --remote-dir /path --resume test-uuid-123',
  );
  t.is(
    persistenceModule.getResumeCommand(id, 'user@host', '/path', 2222),
    'term2 --ssh user@host --remote-dir /path --ssh-port 2222 --resume test-uuid-123',
  );
});

test.serial('writer + loadConversation: round-trips a basic conversation', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({
    id,
    createdAt: '2026-05-26T00:00:00.000Z',
    projectPath: '/workspace/x',
    model: 'gpt-4o',
    provider: 'openai',
  });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'hi there' },
    finalText: 'hi there',
    snapshot: {
      history: [
        { role: 'user', type: 'message', content: 'hello' } as any,
        { role: 'assistant', type: 'message', content: 'hi there' } as any,
      ],
      previousResponseId: 'resp-1',
      toolLedger: [],
      model: 'gpt-4o',
      provider: 'openai',
    },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.truthy(restored);
  t.is(restored!.id, id);
  t.is(restored!.previousResponseId, 'resp-1');
  t.is(restored!.history.length, 2);
  t.is(restored!.messages.length, 2);
  t.is(restored!.messages[0].sender, 'user');
  t.is(restored!.messages[1].sender, 'bot');
});

test.serial('loadConversation: returns null for missing id', (t) => {
  t.is(persistenceModule.loadConversation('nope'), null);
});

test.serial('replay: mid-turn crash with tool_started inserts recovery notice', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  // First turn completes cleanly
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'do it' } });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'done' },
    finalText: 'done',
    snapshot: {
      history: [{ role: 'user', type: 'message', content: 'do it' } as any],
      previousResponseId: 'r1',
      toolLedger: [],
    },
  });
  // Second turn: user submits, tool starts, then crash
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'more' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: {} });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.truthy(restored);
  t.true(restored!.replayWarnings.some((w) => w.includes('interrupted')));
  // Recovery system message present in history
  const hasRecovery = restored!.history.some(
    (item: any) => item?.role === 'system' && typeof item.content === 'string' && item.content.includes('Recovered'),
  );
  t.true(hasRecovery);
  // The interrupted system message is on UI messages
  t.true(restored!.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted')));
});

test.serial('replay: user_message only with no assistant_final flags interruption', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.truthy(restored);
  t.true(restored!.replayWarnings.length > 0);
  t.true(restored!.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted')));
});

test.serial('replay: settings_changed updates restored model', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', model: 'gpt-4o' });
  writer.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
    finalText: 'ok',
    snapshot: { history: [], previousResponseId: null, toolLedger: [], model: 'gpt-5' },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.is(restored!.model, 'gpt-5');
});

test.serial('replay: undo with snapshot replaces state', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'first' } });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'A' },
    finalText: 'A',
    snapshot: {
      history: [{ role: 'user', type: 'message', content: 'first' } as any],
      previousResponseId: 'r1',
      toolLedger: [],
    },
  });
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'second' } });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b2', sender: 'bot', status: 'finalized', text: 'B' },
    finalText: 'B',
    snapshot: {
      history: [{ role: 'user', type: 'message', content: 'first' } as any],
      previousResponseId: 'r2',
      toolLedger: [],
    },
  });
  writer.append({ type: 'undo', removedUserTurns: 1, snapshot: emptySnapshot() });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.is(restored!.history.length, 0);
  t.is(restored!.previousResponseId, null);
});

test.serial('replay: corrupt line is skipped', (t) => {
  const id = persistenceModule.generateId();
  fs.mkdirSync(testDir, { recursive: true });
  const filePath = path.join(testDir, `${id}.jsonl`);
  const goodInit = JSON.stringify({
    v: 1,
    seq: 1,
    ts: '2026-05-26T00:00:00.000Z',
    event: { type: 'session_init', id, createdAt: '2026-05-26T00:00:00.000Z' },
  });
  const goodFinal = JSON.stringify({
    v: 1,
    seq: 3,
    ts: '2026-05-26T00:00:01.000Z',
    event: {
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
      finalText: 'ok',
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    },
  });
  fs.writeFileSync(filePath, `${goodInit}\n{not json\n${goodFinal}\n`, 'utf-8');

  const restored = persistenceModule.loadConversation(id);
  t.is(restored!.previousResponseId, 'r1');
});

test.serial('lock: collision throws LockConflictError', (t) => {
  const id = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w1.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  const w2 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  t.throws(() => w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z' }), { instanceOf: LockConflictError });
  void w1.close();
});

test.serial('lock: released on writer close, second writer succeeds', async (t) => {
  const id = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w1.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  await w1.close();
  const w2 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  t.notThrows(() => w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z' }));
  await w2.close();
});

test.serial('forkConversation: copies the source jsonl to a new id', (t) => {
  const srcId = persistenceModule.generateId();
  const dstId = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: srcId, dir: testDir, logger: stubLogger });
  writer.init({ id: srcId, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'A' },
    finalText: 'A',
    snapshot: {
      history: [{ role: 'user', type: 'message', content: 'hi' } as any],
      previousResponseId: 'r1',
      toolLedger: [],
    },
  });
  void writer.close();

  t.true(persistenceModule.forkConversation(srcId, dstId));
  const restored = persistenceModule.loadConversation(dstId);
  t.is(restored!.previousResponseId, 'r1');
});

test.serial('listConversations: lists sessions sorted by mtime desc', (t) => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/p1' });
  void w1.close();
  // Sleep to ensure mtime differs
  const target = Date.now() + 20;
  while (Date.now() < target) {
    /* spin */
  }
  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/p2' });
  void w2.close();

  const list = persistenceModule.listConversations();
  t.is(list.length, 2);
  t.is(list[0].id, id2);
  t.is(list[0].projectPath, '/p2');
});

test.serial('loadConversation: returns null when expected project path differs', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/alpha' });
  void writer.close();
  t.is(persistenceModule.loadConversation(id, '/workspace/beta'), null);
});

test.serial('loadConversationForProject: reports project mismatch', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/alpha' });
  void writer.close();
  const result = persistenceModule.loadConversationForProject(id, '/workspace/beta');
  t.is(result.status, 'project_mismatch');
});

test.serial('loadConversationForProject: not_found for missing', (t) => {
  t.is(persistenceModule.loadConversationForProject('missing', '/x').status, 'not_found');
});

test.serial('loadLastConversation: returns the last written conversation', (t) => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z' });
  w1.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void w1.close();
  const target = Date.now() + 20;
  while (Date.now() < target) {
    /* spin */
  }
  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z' });
  w2.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi2' } });
  void w2.close();

  const last = persistenceModule.loadLastConversation();
  t.truthy(last);
  t.is(last!.id, id2);
});

test.serial('loadLastConversation: does not save last.json for empty conversation', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  void writer.close();

  const last = persistenceModule.loadLastConversation();
  t.is(last, null);
  t.false(fs.existsSync(path.join(testDir, 'last.json')));
});

test.serial('hasConversationContent: returns false for missing conversation', (t) => {
  t.false(persistenceModule.hasConversationContent('non-existent-id'));
});

test.serial('hasConversationContent: returns false for empty conversation', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  void writer.close();
  t.false(persistenceModule.hasConversationContent(id));
});

test.serial('hasConversationContent: returns true for user_message', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();
  t.true(persistenceModule.hasConversationContent(id));
});

test.serial('hasConversationContent: returns true for assistant_final', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({
    type: 'assistant_final',
    message: { id: 'a1', sender: 'bot', status: 'finalized', text: 'hello' },
    finalText: 'hello',
    snapshot: emptySnapshot(),
  });
  void writer.close();
  t.true(persistenceModule.hasConversationContent(id));
});

test.serial('hasConversationContent: skips corrupt lines and finds content', (t) => {
  const id = persistenceModule.generateId();
  const filePath = path.join(testDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    '{"v":1,"seq":1,"ts":"2026-05-26T00:00:00.000Z","event":{"type":"session_init","id":"' +
      id +
      '","createdAt":"2026-05-26T00:00:00.000Z"}}\n' +
      'this is not json\n' +
      '{"v":1,"seq":2,"ts":"2026-05-26T00:00:01.000Z","event":{"type":"user_message","message":{"id":"u1","sender":"user","text":"hi"}}}\n',
    'utf-8',
  );
  t.true(persistenceModule.hasConversationContent(id));
});

test.serial('deleteConversation: removes the jsonl and clears last.json', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();
  t.true(persistenceModule.deleteConversation(id));
  t.false(fs.existsSync(path.join(testDir, `${id}.jsonl`)));
  t.false(fs.existsSync(path.join(testDir, 'last.json')));
});

// Suppress unused-event-import lint
const _ev: LogEvent | null = null;
void _ev;
