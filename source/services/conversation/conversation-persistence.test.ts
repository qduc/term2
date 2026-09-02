import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter, LockConflictError } from '../logging/conversation-log-writer.js';
import type { LogEvent, StateSnapshot } from '../logging/conversation-log-events.js';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import type { BotMessage, CommandMessage, ReasoningMessage } from '../../types/message.js';
import { createAgentStream } from '../agent-stream.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

let testDir = '';

function cleanupAll() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

process.on('exit', cleanupAll);

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

function assistantTurn(text: string, previousResponseId: string | null = 'r1'): LogEvent {
  return {
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text }] },
    state: { previousResponseId },
  };
}

class MockStream {
  events: unknown[];
  completed = Promise.resolve(undefined);
  lastResponseId = 'resp-v3';
  interruptions: unknown[] = [];
  state = {};
  newItems: unknown[] = [];
  history: unknown[] = [];
  output: unknown[] = [];
  finalOutput = 'Done.';

  constructor(events: unknown[] = []) {
    this.events = events;
    createAgentStream(this as never);
  }

  get runUsage(): unknown {
    return (this.state as { usage?: unknown }).usage;
  }

  async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-conversations-test-'));
  persistenceModule.setConversationsDirForTest(testDir);
});
afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  persistenceModule.setConversationsDirForTest(null);
  persistenceModule.setPidAlivenessCheckForTest(null);
  testDir = '';
});

it.sequential('generateId: returns a valid UUID', () => {
  const id = persistenceModule.generateId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

it.sequential('generateId: returns unique IDs', () => {
  expect(persistenceModule.generateId()).not.toBe(persistenceModule.generateId());
});

it.sequential('loadConversationForProject resolves unique UUID prefixes and reports ambiguous candidates', async () => {
  const first = '12345678-1234-4abc-8def-1234567890ab';
  const second = '12345678-abcd-4abc-8def-1234567890ab';
  for (const id of [first, second]) {
    const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
    writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
    await writer.close();
  }

  expect(persistenceModule.loadConversationForProject('12345678-1', '/project')).toMatchObject({
    status: 'loaded',
    conversation: { id: first },
  });
  expect(persistenceModule.loadConversationForProject('12345678', '/project')).toMatchObject({
    status: 'ambiguous',
    candidates: expect.arrayContaining([
      { id: first, shortRef: '12345678-1' },
      { id: second, shortRef: '12345678-a' },
    ]),
  });
});

it.sequential('getResumeCommand: returns correct format', () => {
  const id = 'test-uuid-123';
  expect(persistenceModule.getResumeCommand(id)).toBe('term2 --resume test-uuid-123');
  expect(persistenceModule.getResumeCommand(id, 'user@host')).toBe('term2 --ssh user@host --resume test-uuid-123');
  expect(persistenceModule.getResumeCommand(id, 'user@host', '/path')).toBe(
    'term2 --ssh user@host --remote-dir /path --resume test-uuid-123',
  );
  expect(persistenceModule.getResumeCommand(id, 'user@host', '/path', 2222)).toBe(
    'term2 --ssh user@host --remote-dir /path --ssh-port 2222 --resume test-uuid-123',
  );
});

it.sequential('getConversationsDir: resolves the CLI writer directory from TERM2_CONVERSATIONS_DIR', () => {
  const expected = path.join(testDir, 'env-resolved');
  const previous = process.env['TERM2_CONVERSATIONS_DIR'];
  persistenceModule.setConversationsDirForTest(null);
  process.env['TERM2_CONVERSATIONS_DIR'] = expected;
  try {
    expect(persistenceModule.getConversationsDir()).toBe(expected);
  } finally {
    if (previous === undefined) delete process.env['TERM2_CONVERSATIONS_DIR'];
    else process.env['TERM2_CONVERSATIONS_DIR'] = previous;
    persistenceModule.setConversationsDirForTest(testDir);
  }
});

it.sequential('writer + loadConversation: round-trips a basic conversation', () => {
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
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'hi there' }] },
    state: { previousResponseId: 'resp-1', model: 'gpt-4o', provider: 'openai' },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.id).toBe(id);
  expect(restored!.previousResponseId).toBe('resp-1');
  expect(restored!.history.length).toBe(2);
  expect(restored!.messages.length).toBe(2);
  expect(restored!.messages[0].sender).toBe('user');
  expect(restored!.messages[1].sender).toBe('bot');
});

it.sequential('loadConversation: skips malformed known event lines and continues replay', () => {
  const id = persistenceModule.generateId();
  const filePath = path.join(testDir, `${id}.jsonl`);
  const events = [
    { type: 'session_init', id, createdAt: '2026-05-26T00:00:00.000Z' },
    { type: 'session_init', id: 12, createdAt: 'bad' },
    { type: 'user_message', message: null },
    { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } },
    { type: 'assistant_turn', turn: { items: 'bad' } },
    { type: 'future_checkpoint', opaque: true },
    {
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'answer' }] },
      state: { previousResponseId: null },
    },
    { type: 'undo', removedUserTurns: 1, snapshot: { history: null } },
  ];
  fs.writeFileSync(
    filePath,
    events
      .map((event, index) => JSON.stringify({ v: 3, seq: index + 1, ts: '2026-05-26T00:00:00.000Z', event }))
      .join('\n') + '\n',
    'utf-8',
  );

  const restored = persistenceModule.loadConversation(id);

  expect(restored).not.toBe(null);
  expect(restored?.messages.map((message) => ('text' in message ? message.text : undefined))).toEqual([
    'hello',
    'answer',
  ]);
});

it.sequential('loadConversation: returns null for missing id', () => {
  expect(persistenceModule.loadConversation('nope')).toBe(null);
});

it.sequential('replay: mid-turn crash with tool_started inserts recovery notice', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  // First turn completes cleanly
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'do it' } });
  writer.append(assistantTurn('done'));
  // Second turn: user submits, tool starts, then crash
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'more' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: {} });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.replayWarnings.some((w) => w.includes('interrupted'))).toBe(true);

  // The interrupted system message is on UI messages
  expect(restored!.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted'))).toBe(true);
});

it.sequential('replay: user_message only with no assistant_turn flags interruption', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.replayWarnings.length > 0).toBe(true);
  expect(restored!.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted'))).toBe(true);
});

it.sequential('replay: settings_changed updates restored model', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', model: 'gpt-4o' });
  writer.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
    state: { previousResponseId: null, model: 'gpt-5' },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored!.model).toBe('gpt-5');
});

it.sequential('replay: undo with snapshot replaces state', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'first' } });
  writer.append(assistantTurn('A'));
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'second' } });
  writer.append(assistantTurn('B', 'r2'));
  writer.append({ type: 'undo', removedUserTurns: 1, snapshot: emptySnapshot() });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored!.history.length).toBe(0);
  expect(restored!.previousResponseId).toBe(null);
});

it.sequential('replay: corrupt line is skipped', () => {
  const id = persistenceModule.generateId();
  fs.mkdirSync(testDir, { recursive: true });
  const filePath = path.join(testDir, `${id}.jsonl`);
  const goodInit = JSON.stringify({
    v: 1,
    seq: 1,
    ts: '2026-05-26T00:00:00.000Z',
    event: { type: 'session_init', id, createdAt: '2026-05-26T00:00:00.000Z' },
  });
  const goodTurn = JSON.stringify({
    v: 3,
    seq: 3,
    ts: '2026-05-26T00:00:01.000Z',
    event: {
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
      state: { previousResponseId: 'r1' },
    },
  });
  fs.writeFileSync(filePath, `${goodInit}\n{not json\n${goodTurn}\n`, 'utf-8');

  const restored = persistenceModule.loadConversation(id);
  expect(restored!.previousResponseId).toBe('r1');
});

it.sequential('lock: collision throws LockConflictError', () => {
  const id = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w1.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  const w2 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });

  expect(() => w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z' })).toThrow(LockConflictError);
  void w1.close();
});

it.sequential('lock: released on writer close, second writer succeeds', async () => {
  const id = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w1.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  await w1.close();
  const w2 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  expect(() => w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z' })).not.toThrow();
  await w2.close();
});

it.sequential('lock: writer init against existing corrupt lockfile still throws LockConflictError', () => {
  const id = persistenceModule.generateId();
  fs.writeFileSync(path.join(testDir, `${id}.lock`), '{corrupt-lock-data', 'utf-8');
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  expect(() => writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' })).toThrow(LockConflictError);
});

it.sequential('forkConversation: immediately persists the fork identity, provenance, and source history', () => {
  const srcId = persistenceModule.generateId();
  const dstId = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: srcId, dir: testDir, logger: stubLogger });
  writer.init({ id: srcId, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/source' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
  writer.append(assistantTurn('A'));
  void writer.close();

  expect(persistenceModule.forkConversation(srcId, dstId)).toBe(true);
  const restored = persistenceModule.loadConversation(dstId);
  expect(restored).toMatchObject({
    id: dstId,
    forkedFrom: srcId,
    projectPath: '/workspace/source',
    previousResponseId: 'r1',
  });
  expect(restored!.history).toHaveLength(2);
  expect(restored!.messages).toMatchObject([{ text: 'hello' }, { text: 'A' }]);
});

it.sequential(
  'forkConversation: rewrites every session_init so later initialization cannot restore source identity',
  () => {
    const srcId = persistenceModule.generateId();
    const dstId = persistenceModule.generateId();
    const writer = createConversationLogWriter({ sessionId: srcId, dir: testDir, logger: stubLogger });
    writer.init({ id: srcId, createdAt: '2026-05-26T00:00:00.000Z' });
    writer.append(assistantTurn('before re-init'));
    writer.append({ type: 'session_init', id: srcId, createdAt: '2026-05-26T00:01:00.000Z' });
    writer.append(assistantTurn('after re-init', 'r2'));
    void writer.close();

    expect(persistenceModule.forkConversation(srcId, dstId)).toBe(true);
    expect(persistenceModule.loadConversation(dstId)).toMatchObject({
      id: dstId,
      forkedFrom: srcId,
      previousResponseId: 'r2',
    });
  },
);

it.sequential('forkConversation: terminates a partial trailing record before subsequent writer appends', async () => {
  const srcId = persistenceModule.generateId();
  const dstId = persistenceModule.generateId();
  const sourceWriter = createConversationLogWriter({ sessionId: srcId, dir: testDir, logger: stubLogger });
  sourceWriter.init({ id: srcId, createdAt: '2026-05-26T00:00:00.000Z' });
  sourceWriter.append(assistantTurn('source history'));
  await sourceWriter.close();
  fs.appendFileSync(path.join(testDir, `${srcId}.jsonl`), '{"v":3,"seq":99,"event":');

  expect(persistenceModule.forkConversation(srcId, dstId)).toBe(true);
  expect(persistenceModule.loadConversation(dstId)!.messages).toMatchObject([{ text: 'source history' }]);
  const forkWriter = createConversationLogWriter({ sessionId: dstId, dir: testDir, logger: stubLogger });
  forkWriter.init({ id: dstId, createdAt: '2026-05-26T00:02:00.000Z', forkedFrom: srcId });
  forkWriter.append(assistantTurn('after fork', 'r-after'));
  await forkWriter.close();

  const restored = persistenceModule.loadConversation(dstId);
  expect(restored).toMatchObject({ id: dstId, forkedFrom: srcId, previousResponseId: 'r-after' });
  expect(restored!.messages).toContainEqual(expect.objectContaining({ text: 'after fork' }));
});

it.sequential('listConversations: lists sessions sorted by mtime desc', () => {
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
  expect(list.length).toBe(2);
  expect(list[0].id).toBe(id2);
  expect(list[0].projectPath).toBe('/p2');
});

it.sequential('listConversations: filters sessions by workspace and ssh host', () => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/p1' });
  void w1.close();

  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/p2' });
  void w2.close();

  const id3 = persistenceModule.generateId();
  const w3 = createConversationLogWriter({ sessionId: id3, dir: testDir, logger: stubLogger });
  w3.init({ id: id3, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/p1', sshHost: 'host1' });
  void w3.close();

  // Filter for local /workspace/p1
  const listP1Local = persistenceModule.listConversations('/workspace/p1');
  expect(listP1Local.length).toBe(1);
  expect(listP1Local[0].id).toBe(id1);

  // Filter for remote /workspace/p1 on host1
  const listP1Host1 = persistenceModule.listConversations('/workspace/p1', 'host1');
  expect(listP1Host1.length).toBe(1);
  expect(listP1Host1[0].id).toBe(id3);

  // Filter for /workspace/p2
  const listP2Local = persistenceModule.listConversations('/workspace/p2');
  expect(listP2Local.length).toBe(1);
  expect(listP2Local[0].id).toBe(id2);
});

it.sequential('loadConversation: returns null when expected project path differs', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/alpha' });
  void writer.close();
  expect(persistenceModule.loadConversation(id, '/workspace/beta')).toBe(null);
});

it.sequential('loadConversationForProject: reports project mismatch', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/workspace/alpha' });
  void writer.close();
  const result = persistenceModule.loadConversationForProject(id, '/workspace/beta');
  expect(result.status).toBe('project_mismatch');
});

it.sequential('loadConversationForProject: not_found for missing', () => {
  expect(persistenceModule.loadConversationForProject('missing', '/x').status).toBe('not_found');
});

it.sequential('loadLastConversation: returns the last written conversation', () => {
  const id1 = persistenceModule.generateId();
  const filePath1 = path.join(testDir, `${id1}.jsonl`);
  fs.writeFileSync(
    filePath1,
    [
      envelopeLine(1, { type: 'session_init', id: id1, createdAt: '2026-05-26T00:00:00.000Z' }),
      envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    ].join(''),
    'utf-8',
  );

  const id2 = persistenceModule.generateId();
  const filePath2 = path.join(testDir, `${id2}.jsonl`);
  fs.writeFileSync(
    filePath2,
    [
      envelopeLine(1, { type: 'session_init', id: id2, createdAt: '2026-05-26T01:00:00.000Z' }),
      envelopeLine(2, { type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi2' } }),
    ].join(''),
    'utf-8',
  );

  // Seed last.json with deterministic updatedAt order
  fs.writeFileSync(
    path.join(testDir, 'last.json'),
    JSON.stringify({
      entries: [
        { id: id1, updatedAt: '2026-05-26T00:00:00.000Z' },
        { id: id2, updatedAt: '2026-05-26T01:00:00.000Z' },
      ],
    }),
    'utf-8',
  );

  const last = persistenceModule.loadLastConversation();
  expect(last).toBeTruthy();
  expect(last!.id).toBe(id2);
});

it.sequential('loadLastConversation: does not save last.json for empty conversation', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  void writer.close();

  const last = persistenceModule.loadLastConversation();
  expect(last).toBe(null);
  expect(fs.existsSync(path.join(testDir, 'last.json'))).toBe(false);
});

it.sequential('hasConversationContent: returns false for missing conversation', () => {
  expect(persistenceModule.hasConversationContent('non-existent-id')).toBe(false);
});

it.sequential('hasConversationContent: returns false for empty conversation', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  void writer.close();
  expect(persistenceModule.hasConversationContent(id)).toBe(false);
});

it.sequential('hasConversationContent: returns true for user_message', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();
  expect(persistenceModule.hasConversationContent(id)).toBe(true);
});

it.sequential('hasConversationContent: returns true for assistant_turn', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append(assistantTurn('hello'));
  void writer.close();
  expect(persistenceModule.hasConversationContent(id)).toBe(true);
});

it.sequential('hasConversationContent: ignores unsupported assistant_final events', () => {
  const id = persistenceModule.generateId();
  const filePath = path.join(testDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      v: 1,
      seq: 1,
      ts: '2026-05-26T00:00:00.000Z',
      event: { type: 'assistant_final', message: { id: 'a1', sender: 'bot', text: 'legacy' } },
    }) + '\n',
    'utf-8',
  );
  expect(persistenceModule.hasConversationContent(id)).toBe(false);
});

it.sequential('hasConversationContent: skips corrupt lines and finds content', () => {
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
  expect(persistenceModule.hasConversationContent(id)).toBe(true);
});

it.sequential('deleteConversation: removes the jsonl and clears last.json', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void writer.close();
  expect(persistenceModule.deleteConversation(id)).toBe(true);
  expect(fs.existsSync(path.join(testDir, `${id}.jsonl`))).toBe(false);
  expect(fs.existsSync(path.join(testDir, 'last.json'))).toBe(false);
});

it.sequential('subagent_completed and corresponding records omit nestedRunResult', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });

  // 1. Log subagent_completed event
  writer.append({
    type: 'subagent_completed',
    result: {
      agentId: 'sub-agent-1',
      role: 'worker',
      status: 'completed',
      finalText: 'Task resolved successfully',
      filesChanged: ['src/app.ts'],
      toolsUsed: [{ toolName: 'create_file', count: 1 }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      nestedRunResult: {
        state: {
          history: [{ role: 'user', content: 'test' }],
          generatedItems: ['item1'],
        },
      },
    } as any,
  });

  // 2. Log tool_result event with JSON string containing nestedRunResult
  writer.append({
    type: 'tool_result',
    callId: 'call-subagent-1',
    toolName: 'run_subagent',
    status: 'completed',
    output: JSON.stringify({
      status: 'completed',
      finalText: 'Result text',
      nestedRunResult: { state: { internalStuff: 'hidden' } },
    }),
  });

  // 3. Log assistant_turn event with nestedRunResult in turn items
  writer.append({
    type: 'assistant_turn',
    turn: {
      items: [
        {
          type: 'tool_result',
          callId: 'call-subagent-1',
          toolName: 'run_subagent',
          status: 'completed',
          output: JSON.stringify({
            status: 'completed',
            finalText: 'Turn result text',
            nestedRunResult: { state: { internalStuff: 'hidden' } },
          }),
        },
        { type: 'assistant_text', text: 'all done' },
      ],
    },
    state: { previousResponseId: 'resp-1' },
  });

  void writer.close();

  // Load raw file contents to check what was written to disk
  const filePath = path.join(testDir, `${id}.jsonl`);
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

  // Parse lines to check events
  const envelopes = lines.map((line) => JSON.parse(line));

  // Find subagent_completed
  const completedEnv = envelopes.find((env) => env.event?.type === 'subagent_completed');
  expect(completedEnv).toBeTruthy();
  expect(completedEnv.event.result.status).toBe('completed');
  expect(completedEnv.event.result.finalText).toBe('Task resolved successfully');
  expect(completedEnv.event.result.filesChanged).toEqual(['src/app.ts']);
  expect(completedEnv.event.result.nestedRunResult).toBe(undefined);

  // Find tool_result
  const toolResultEnv = envelopes.find((env) => env.event?.type === 'tool_result');
  expect(toolResultEnv).toBeTruthy();
  expect(toolResultEnv.event.toolName).toBe('run_subagent');
  const parsedOutput = JSON.parse(toolResultEnv.event.output);
  expect(parsedOutput.status).toBe('completed');
  expect(parsedOutput.finalText).toBe('Result text');
  expect(parsedOutput.nestedRunResult).toBe(undefined);

  // Find assistant_turn and check turn items
  const turnEnv = envelopes.find((env) => env.event?.type === 'assistant_turn');
  expect(turnEnv).toBeTruthy();
  const turnOutput = JSON.parse(turnEnv.event.turn.items[0].output);
  expect(turnOutput.status).toBe('completed');
  expect(turnOutput.finalText).toBe('Turn result text');
  expect(turnOutput.nestedRunResult).toBe(undefined);
});

it.sequential('saveLastConversation: stores per-project last conversation', () => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/project-a' });
  w1.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi a' } });
  void w1.close();

  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/project-b' });
  w2.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi b' } });
  void w2.close();

  const lastA = persistenceModule.loadLastConversation('/project-a');
  expect(lastA).toBeTruthy();
  expect(lastA!.id).toBe(id1);

  const lastB = persistenceModule.loadLastConversation('/project-b');
  expect(lastB).toBeTruthy();
  expect(lastB!.id).toBe(id2);
});

it.sequential('saveLastConversation: stores per-ssh-host last conversation', () => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/remote', sshHost: 'host-a' });
  w1.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi a' } });
  void w1.close();

  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/remote', sshHost: 'host-b' });
  w2.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi b' } });
  void w2.close();

  const lastA = persistenceModule.loadLastConversation('/remote', 'host-a');
  expect(lastA).toBeTruthy();
  expect(lastA!.id).toBe(id1);

  const lastB = persistenceModule.loadLastConversation('/remote', 'host-b');
  expect(lastB).toBeTruthy();
  expect(lastB!.id).toBe(id2);
});

it.sequential('loadLastConversation: falls back to scanning when no last.json entry matches', () => {
  const id = persistenceModule.generateId();
  const w = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/fallback' });
  w.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void w.close();

  // Directly overwrite last.json so the entry has no projectPath
  fs.writeFileSync(
    path.join(testDir, 'last.json'),
    JSON.stringify({ entries: [{ id, updatedAt: new Date().toISOString() }] }),
    'utf-8',
  );

  const last = persistenceModule.loadLastConversation('/fallback');
  expect(last).toBeTruthy();
  expect(last!.id).toBe(id);
});

it.sequential('loadLastConversation: migrates old last.json format', () => {
  const id = persistenceModule.generateId();
  const w = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  w.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void w.close();

  // Simulate old format
  fs.writeFileSync(
    path.join(testDir, 'last.json'),
    JSON.stringify({ id, updatedAt: '2026-05-26T00:00:00.000Z' }),
    'utf-8',
  );

  const last = persistenceModule.loadLastConversation();
  expect(last).toBeTruthy();
  expect(last!.id).toBe(id);
});

it.sequential('deleteConversation: removes only matching entry from last.json', () => {
  const id1 = persistenceModule.generateId();
  const w1 = createConversationLogWriter({ sessionId: id1, dir: testDir, logger: stubLogger });
  w1.init({ id: id1, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/project-a' });
  w1.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi a' } });
  void w1.close();

  const id2 = persistenceModule.generateId();
  const w2 = createConversationLogWriter({ sessionId: id2, dir: testDir, logger: stubLogger });
  w2.init({ id: id2, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/project-b' });
  w2.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi b' } });
  void w2.close();

  expect(persistenceModule.deleteConversation(id1)).toBe(true);
  expect(fs.existsSync(path.join(testDir, `${id1}.jsonl`))).toBe(false);
  expect(fs.existsSync(path.join(testDir, 'last.json'))).toBe(true);

  const lastB = persistenceModule.loadLastConversation('/project-b');
  expect(lastB).toBeTruthy();
  expect(lastB!.id).toBe(id2);
});

it.sequential('saveLastConversation: updates entry when projectPath changes for same id', () => {
  const id = persistenceModule.generateId();
  const w = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/old-path' });
  w.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  void w.close();

  // Re-open same session with different project path (simulating rotate or manual update)
  const w2 = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/new-path' });
  w2.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hi again' } });
  void w2.close();

  expect(persistenceModule.loadLastConversation('/old-path')).toBe(null);

  const lastNew = persistenceModule.loadLastConversation('/new-path');
  expect(lastNew).toBeTruthy();
  expect(lastNew!.id).toBe(id);
});

// Suppress unused-event-import lint
const _ev: LogEvent | null = null;
void _ev;

it.sequential('writer + loadConversation: round-trips a v2 conversation with assistant_turn', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({
    id,
    createdAt: '2026-05-26T00:00:00.000Z',
    projectPath: '/workspace/y',
    model: 'gpt-4o',
    provider: 'openai',
  });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run tool' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-v2', toolName: 'shell', arguments: 'ls' });
  writer.append({
    type: 'command_message',
    message: {
      id: 'cmd-v2',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'file.txt',
      success: true,
      callId: 'call-v2',
      toolName: 'shell',
    },
  });
  writer.append({
    type: 'assistant_turn',
    turn: {
      items: [
        {
          type: 'reasoning',
          text: 'thinking about ls',
          // A recognized native-reasoning envelope must survive JSONL replay,
          // not merely the in-memory session projection.
          providerMetadata: { codex: { encrypted_content: 'fixture-encrypted-reasoning' } },
        },
        { type: 'tool_call', callId: 'call-v2', toolName: 'shell', arguments: 'ls' },
        // The durable result shape is the same for a model-requested unknown
        // tool rejection as for a completed local tool.
        { type: 'tool_result', callId: 'call-v2', toolName: 'shell', status: 'failed', output: 'unknown tool' },
        { type: 'assistant_text', text: 'here is the file' },
      ],
    },
    snapshot: {
      history: [
        { role: 'user', type: 'message', content: 'run tool' } as any,
        { role: 'assistant', type: 'message', content: 'here is the file' } as any,
      ],
      previousResponseId: 'resp-v2',
      toolLedger: [
        {
          turnId: 'turn-1',
          callId: 'call-v2',
          toolName: 'shell',
          status: 'completed',
          startedAt: '2026-05-26T00:00:00.000Z',
          completedAt: '2026-05-26T00:00:01.000Z',
          arguments: 'ls',
          output: 'file.txt',
        },
      ],
      model: 'gpt-4o',
      provider: 'openai',
    },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.id).toBe(id);
  expect(restored!.previousResponseId).toBe('resp-v2');
  // Reasoning is reconstructed as a standalone history item (matching the live SDK
  // output), NOT folded into the following tool_call's providerData. Folding caused
  // the reasoning_content to be serialized onto both the assistant message and the
  // tool call (duplicate reasoning_content) by the chat-completions converter.
  expect(restored!.history.length).toBe(5);
  expect(restored!.history[0]).toMatchObject({ role: 'user' });
  expect(restored!.history[1]).toEqual({
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'thinking about ls' }],
    rawContent: [{ type: 'reasoning_text', text: 'thinking about ls' }],
    providerData: { codex: { encrypted_content: 'fixture-encrypted-reasoning' } },
  });
  expect(restored!.history[2]).toEqual({
    type: 'function_call',
    callId: 'call-v2',
    name: 'shell',
    arguments: 'ls',
  });
  expect(restored!.history[3]).toEqual({
    type: 'function_call_result',
    callId: 'call-v2',
    name: 'shell',
    output: 'unknown tool',
  });
  expect(restored!.history[4]).toEqual({
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'here is the file' }],
  });
  expect(restored!.toolLedger.length).toBe(1);
  expect(restored!.toolLedger[0].callId).toBe('call-v2');

  // exact messages ordering: user, reasoning, command, bot
  expect(restored!.messages.length).toBe(4);
  expect(restored!.messages[0].sender).toBe('user');
  expect(restored!.messages[1].sender).toBe('reasoning');
  expect((restored!.messages[1] as ReasoningMessage).text).toBe('thinking about ls');
  expect(restored!.messages[2].sender).toBe('command');
  expect((restored!.messages[2] as CommandMessage).status).toBe('failed');
  expect(restored!.messages[3].sender).toBe('bot');
  expect((restored!.messages[3] as BotMessage).text).toBe('here is the file');
});

it.sequential('session logging writes compact v3 assistant_turn state without cumulative snapshot', async () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({
    id,
    createdAt: '2026-05-26T00:00:00.000Z',
    projectPath: '/workspace/v3',
    model: 'gpt-5',
    provider: 'openai',
  });

  const stream = new MockStream();
  stream.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done.' }],
    },
  ];
  const bundle = createConversationSession({
    sessionId: id,
    agentClient: {
      startStream: async () => stream,
      getProvider: () => 'openai',
    } as any,
    deps: {
      logger: stubLogger,
      settingsService: createMockSettingsService({
        'agent.model': 'gpt-5',
        'agent.provider': 'openai',
      }),
      sessionContextService: createSessionContextService() as any,
    },
    sessionStartedAt: '2026-05-26T00:00:00.000Z',
  });
  const { terminalAdapter, conversationLogger } = bundle;
  conversationLogger.setLogSink((event) => writer.append(event));

  const result = await terminalAdapter.sendMessage('hello');
  expect(result.type).toBe('response');
  await writer.close();

  const filePath = path.join(testDir, `${id}.jsonl`);
  const envelopes = fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turnEnvelope = envelopes.find((env) => env.event?.type === 'assistant_turn');

  expect(turnEnvelope).toBeTruthy();
  expect(turnEnvelope.v).toBe(3);
  expect(turnEnvelope.event.state).toEqual({
    previousResponseId: 'resp-v3',
    model: 'gpt-5',
    provider: 'openai',
  });
  expect(turnEnvelope.event.displayUsage).toBe(undefined);
  expect(turnEnvelope.event.snapshot).toBe(undefined);
  expect(turnEnvelope.event.turn.items.length).toBe(1);
  expect(turnEnvelope.event.turn.items[0].text).toBe('Done.');
});

it.sequential('session logging persists displayUsage separately from cumulative assistant_turn usage', async () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({
    id,
    createdAt: '2026-05-26T00:00:00.000Z',
    projectPath: '/workspace/display-usage',
    model: 'gpt-5',
    provider: 'openai',
  });

  const initialStream = new MockStream([
    { type: 'usage_update', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
  ]);
  initialStream.state = {
    approve: () => {},
    usage: { inputTokens: 120, outputTokens: 12, totalTokens: 132 },
  };
  initialStream.interruptions = [
    {
      name: 'shell',
      arguments: { command: 'ls' },
      callId: 'call-1',
      agent: { name: 'Agent' },
    },
  ];

  const continuationStream = new MockStream([
    { type: 'usage_update', usage: { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 } },
  ]);
  continuationStream.newItems = [
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: { command: 'ls' },
    },
    {
      type: 'function_call_result',
      callId: 'call-1',
      name: 'shell',
      output: 'files',
    },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Done.' }],
    },
  ];
  continuationStream.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done.' }],
    },
  ];
  continuationStream.state = {
    usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
  };

  const bundle = createConversationSession({
    sessionId: id,
    agentClient: {
      getProvider: () => 'openai',
      startStream: async () => initialStream,
      continueRunStream: async () => continuationStream,
    } as any,
    deps: {
      logger: stubLogger,
      settingsService: createMockSettingsService({
        'agent.model': 'gpt-5',
        'agent.provider': 'openai',
      }),
      sessionContextService: createSessionContextService() as any,
    },
    sessionStartedAt: '2026-05-26T00:00:00.000Z',
  });
  const { terminalAdapter, conversationLogger, shellAutoApproval } = bundle;

  (shellAutoApproval as any).setDelegate({
    resolveAdvisoryForInterruption: async () => ({ model: 'gpt-5', reasoning: 'allow', decision: 'approve' }),
    shouldAutoApprove: () => true,
    isUnsandboxedApprovalEligible: () => false,
    clearCache: () => {},
  });

  conversationLogger.setLogSink((event) => writer.append(event));

  await terminalAdapter.sendMessage('hello');
  await writer.close();

  const filePath = path.join(testDir, `${id}.jsonl`);
  const envelopes = fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turnEnvelope = envelopes.find((env) => env.event?.type === 'assistant_turn');

  expect(turnEnvelope).toBeTruthy();
  expect(turnEnvelope.event.usage).toMatchObject({ prompt_tokens: 300 });
  expect(turnEnvelope.event.displayUsage).toMatchObject({ prompt_tokens: 175 });
});

it.sequential('replay: interrupted v2 logs without assistant_turn still recover from coarse events', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'interrupted' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-coarse', toolName: 'shell', arguments: 'ls' });
  writer.append({
    type: 'command_message',
    message: {
      id: 'cmd-coarse',
      sender: 'command',
      status: 'completed',
      command: 'ls',
      output: 'some files',
      success: true,
      callId: 'call-coarse',
      toolName: 'shell',
    },
  });
  // No assistant_turn written!
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.replayWarnings.some((w) => w.includes('interrupted'))).toBe(true);
  expect(restored!.messages.length).toBe(3); // user, command, system interrupted warning
  expect(restored!.messages[0].sender).toBe('user');
  expect(restored!.messages[1].sender).toBe('command');
  expect((restored!.messages[1] as CommandMessage).status).toBe('completed');
  expect(restored!.messages[2].sender).toBe('system');
});

it.sequential(
  'session logging with auto-approved tool continuation writes only one assistant_turn containing all details',
  async () => {
    const id = persistenceModule.generateId();
    const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
    writer.init({
      id,
      createdAt: '2026-05-26T00:00:00.000Z',
      projectPath: '/workspace/autoapprove',
      model: 'gpt-5',
      provider: 'openai',
    });

    const stream1 = new MockStream();
    stream1.state = {
      approve: () => {},
    };
    stream1.interruptions = [
      {
        name: 'shell',
        arguments: { command: 'echo hello' },
        callId: 'call-1',
        agent: { name: 'Agent' },
      },
    ];

    let continueCalled = false;
    const mockAgentClient = {
      getProvider: () => 'openai',
      startStream: async () => stream1,
      continueRunStream: async () => {
        continueCalled = true;
        const stream2 = new MockStream();
        stream2.newItems = [
          {
            type: 'function_call',
            callId: 'call-1',
            name: 'shell',
            arguments: { command: 'echo hello' },
          },
          {
            type: 'function_call_result',
            callId: 'call-1',
            name: 'shell',
            output: 'hello\n',
          },
          {
            role: 'assistant',
            type: 'message',
            content: [{ type: 'output_text', text: 'Done continuation.' }],
          },
        ];
        stream2.output = [
          {
            role: 'assistant',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done continuation.' }],
          },
        ];
        // Runtime history is cumulative and may include prior turns. Current-run
        // newItems must win so this old assistant message is not persisted again.
        stream2.history = [
          {
            role: 'assistant',
            type: 'message',
            content: [{ type: 'output_text', text: 'Prior turn.' }],
          },
          ...stream2.newItems,
        ];
        return stream2;
      },
    } as any;

    const bundle = createConversationSession({
      sessionId: id,
      agentClient: mockAgentClient,
      deps: {
        logger: stubLogger,
        settingsService: createMockSettingsService({
          'agent.model': 'gpt-5',
          'agent.provider': 'openai',
        }),
        sessionContextService: createSessionContextService() as any,
      },
      sessionStartedAt: '2026-05-26T00:00:00.000Z',
    });
    const { terminalAdapter, conversationLogger, shellAutoApproval } = bundle;

    // Inject a mock shellAutoApproval resolver that auto-approves
    (shellAutoApproval as any).setDelegate({
      resolveAdvisoryForInterruption: async () => ({ model: 'gpt-5', reasoning: 'allow', decision: 'approve' }),
      shouldAutoApprove: () => true,
      isUnsandboxedApprovalEligible: () => false,
      clearCache: () => {},
    });

    conversationLogger.setLogSink((event) => writer.append(event));

    const result = await terminalAdapter.sendMessage('hello');
    expect(result.type).toBe('response');
    expect(continueCalled).toBe(true);
    await writer.close();

    // Read raw file contents to check what was written to disk
    const filePath = path.join(testDir, `${id}.jsonl`);
    const envelopes = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    const assistantTurnEnvelopes = envelopes.filter((env) => env.event?.type === 'assistant_turn');

    // Verify that EXACTLY one assistant_turn event was logged!
    expect(assistantTurnEnvelopes.length).toBe(1);

    const turnEvent = assistantTurnEnvelopes[0].event;
    expect(turnEvent).toBeTruthy();
    expect(turnEvent.turn.items.length).toBe(3); // tool_call, tool_result, assistant_text

    expect(turnEvent.turn.items[0].type).toBe('tool_call');
    expect(turnEvent.turn.items[0].callId).toBe('call-1');
    expect(turnEvent.turn.items[1].type).toBe('tool_result');
    expect(turnEvent.turn.items[1].callId).toBe('call-1');
    expect(turnEvent.turn.items[2].type).toBe('assistant_text');
    expect(turnEvent.turn.items[2].text).toBe('Done continuation.');
  },
);

it.sequential('ensureConversationsDir: automatically migrates files from log to data directory', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-log-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-db-'));

  try {
    // Create dummy files in the old log directory
    const testFile1 = 'test-session-1.jsonl';
    const testFile2 = 'last.json';
    const otherFile = 'unrelated.txt';

    fs.writeFileSync(path.join(logDir, testFile1), 'envelope 1', 'utf-8');
    fs.writeFileSync(path.join(logDir, testFile2), 'last data', 'utf-8');
    fs.writeFileSync(path.join(logDir, otherFile), 'text', 'utf-8');

    // Setup environments and trigger ensureConversationsDir by setting test override
    process.env['TERM2_TEST_LOG_DIR'] = logDir;
    process.env['TERM2_TEST_DB_DIR'] = dbDir;
    persistenceModule.setConversationsDirForTest(dbDir);

    // Call loadConversation for a non-existent ID to trigger ensureConversationsDir
    persistenceModule.loadConversation('non-existent-id');

    // Verify files are migrated
    expect(fs.existsSync(path.join(dbDir, testFile1))).toBe(true);
    expect(fs.existsSync(path.join(dbDir, testFile2))).toBe(true);
    expect(fs.existsSync(path.join(dbDir, otherFile))).toBe(false); // Unrelated files should not be migrated
    expect(fs.existsSync(path.join(logDir, testFile1))).toBe(false);
    expect(fs.existsSync(path.join(logDir, testFile2))).toBe(false);

    expect(fs.readFileSync(path.join(dbDir, testFile1), 'utf-8')).toBe('envelope 1');
    expect(fs.readFileSync(path.join(dbDir, testFile2), 'utf-8')).toBe('last data');
  } finally {
    // Cleanup
    delete process.env['TERM2_TEST_LOG_DIR'];
    delete process.env['TERM2_TEST_DB_DIR'];
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

it.sequential('ensureConversationsDir: migrated conversations are not resurrected after deletion', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-log-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-db-'));

  try {
    const migratedId = 'migrated-session';
    fs.writeFileSync(path.join(logDir, `${migratedId}.jsonl`), 'stub', 'utf-8');

    process.env['TERM2_TEST_LOG_DIR'] = logDir;
    process.env['TERM2_TEST_DB_DIR'] = dbDir;
    persistenceModule.setConversationsDirForTest(dbDir);

    persistenceModule.loadConversation('non-existent-id');
    expect(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`))).toBe(true);

    expect(persistenceModule.deleteConversation(migratedId)).toBe(true);
    expect(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`))).toBe(false);

    persistenceModule.loadConversation('another-non-existent-id');
    expect(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(logDir, `${migratedId}.jsonl`))).toBe(false);
  } finally {
    delete process.env['TERM2_TEST_LOG_DIR'];
    delete process.env['TERM2_TEST_DB_DIR'];
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

it.sequential('writer + loadConversation: round-trips a crash-after-partial-text journal', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'say hi' } });
  // Simulate streamed reasoning + text deltas that landed before a crash.
  writer.append({
    type: 'assistant_journal_delta',
    turnId: 'turn-1',
    seq: 1,
    kind: 'reasoning',
    delta: 'think',
  });
  writer.append({
    type: 'assistant_journal_delta',
    turnId: 'turn-1',
    seq: 2,
    kind: 'text',
    delta: 'hi there',
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.messages.some((m) => m.sender === 'reasoning' && m.text === 'think')).toBe(true);
  expect(restored!.messages.some((m) => m.sender === 'bot' && m.text === 'hi there')).toBe(true);
  expect(restored!.previousResponseId).toBe(null);
});

it.sequential('writer + loadConversation: round-trips a crash-after-tool-start journal', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } });
  writer.append({
    type: 'assistant_journal_item',
    turnId: 'turn-1',
    seq: 1,
    item: {
      type: 'tool_call',
      callId: 'call-1',
      toolName: 'shell',
      arguments: { command: 'pwd' },
      providerItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'pwd' }),
      },
    },
  });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  // Tool call survives the crash and is visible in the tool ledger.
  expect(restored!.toolLedger.some((e) => e.callId === 'call-1')).toBe(true);
  expect(restored!.history.some((h: any) => h.type === 'function_call' && h.callId === 'call-1')).toBe(true);
});

it.sequential('writer + loadConversation: old logs without journal entries still load', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z', model: 'gpt-4o' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } });
  writer.append(assistantTurn('hello', 'r1'));
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  expect(restored!.previousResponseId).toBe('r1');
  expect(restored!.model).toBe('gpt-4o');
  expect(restored!.messages.some((m) => m.sender === 'bot' && m.text === 'hello')).toBe(true);
});

// --- delta sidecar -----------------------------------------------------------
//
// Deltas moved out of the canonical log into a `<sessionId>.deltas` sidecar
// that survives only a crash mid-turn. Recovery must produce exactly what the
// old inline-delta format produced.

function envelopeLine(seq: number, event: unknown): string {
  return `${JSON.stringify({ v: 3, seq, ts: '2026-06-01T00:00:00.000Z', event })}\n`;
}

const interruptedTurnEvents = (id: string): unknown[] => [
  { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' },
  { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'explain this' } },
  { type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'It works ' },
  { type: 'assistant_journal_delta', turnId: 't1', seq: 2, kind: 'text', delta: 'like so.' },
];

it.sequential('delta sidecar: an interrupted turn replays identically to the legacy inline format', async () => {
  const legacyId = 'legacy-inline';
  const legacyPath = path.join(testDir, `${legacyId}.jsonl`);
  fs.writeFileSync(
    legacyPath,
    interruptedTurnEvents(legacyId)
      .map((event, index) => envelopeLine(index + 1, event))
      .join(''),
  );
  const legacy = persistenceModule.loadConversation(legacyId);

  const splitId = 'split-sidecar';
  const writer = createConversationLogWriter({
    sessionId: splitId,
    dir: testDir,
    logger: stubLogger,
    saveLast: () => {},
  });
  writer.init({ id: splitId, createdAt: '2026-06-01T00:00:00.000Z' });
  for (const event of interruptedTurnEvents(splitId).slice(1)) {
    writer.append(event as LogEvent);
  }
  await writer.close();

  // The turn never settled, so the sidecar must have survived close.
  expect(fs.existsSync(path.join(testDir, `${splitId}.deltas`))).toBe(true);
  const split = persistenceModule.loadConversation(splitId);

  const shape = (state: ReturnType<typeof persistenceModule.loadConversation>) =>
    state!.messages.map((m) => ({ sender: m.sender, text: 'text' in m ? m.text : undefined }));

  expect(shape(split)).toEqual(shape(legacy));
  expect(shape(split).some((m) => m.text?.includes('It works like so.'))).toBe(true);
});

it.sequential('delta sidecar: a missing sidecar still loads the settled part of a conversation', () => {
  const id = 'sidecar-absent';
  fs.writeFileSync(
    path.join(testDir, `${id}.jsonl`),
    [
      envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
      envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
      envelopeLine(4, assistantTurn('hello')),
    ].join(''),
  );

  // seq 3 belonged to a delta that was dropped with the sidecar; the gap must
  // not disturb replay.
  const restored = persistenceModule.loadConversation(id);
  expect(restored!.messages.some((m) => m.sender === 'bot' && m.text === 'hello')).toBe(true);
});

it.sequential('delta sidecar: GC removes only sidecars whose conversation log is gone', () => {
  const liveId = 'gc-live';
  const orphanId = 'gc-orphan';

  // A crashed-but-resumable session: canonical log present, sidecar retained.
  fs.writeFileSync(
    path.join(testDir, `${liveId}.jsonl`),
    envelopeLine(1, { type: 'session_init', id: liveId, createdAt: '2026-06-01T00:00:00.000Z' }),
  );
  fs.writeFileSync(
    path.join(testDir, `${liveId}.deltas`),
    envelopeLine(2, { type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'keep me' }),
  );
  // An orphan: no canonical log, so it can never be resumed.
  fs.writeFileSync(
    path.join(testDir, `${orphanId}.deltas`),
    envelopeLine(1, { type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'garbage' }),
  );

  expect(persistenceModule.collectOrphanedDeltaSidecars()).toBe(1);

  // The crash-recovery sidecar must survive: deleting it would destroy the
  // very data it exists to preserve.
  expect(fs.existsSync(path.join(testDir, `${liveId}.deltas`))).toBe(true);
  expect(fs.existsSync(path.join(testDir, `${orphanId}.deltas`))).toBe(false);
});

it.sequential('delta sidecar: forking a session with a live sidecar carries settled turns only', async () => {
  const sourceId = 'fork-source';
  const writer = createConversationLogWriter({
    sessionId: sourceId,
    dir: testDir,
    logger: stubLogger,
    saveLast: () => {},
  });
  writer.init({ id: sourceId, createdAt: '2026-06-01T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'settled question' } });
  writer.append(assistantTurn('settled answer'));
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'interrupted question' } });
  writer.append({ type: 'assistant_journal_delta', turnId: 't2', seq: 1, kind: 'text', delta: 'never finished' });
  await writer.close();

  expect(fs.existsSync(path.join(testDir, `${sourceId}.deltas`))).toBe(true);

  const forkId = 'fork-target';
  expect(persistenceModule.forkConversation(sourceId, forkId)).toBe(true);

  // The sidecar is deliberately not copied: a fork of a half-streamed turn is
  // not a coherent artifact, and its seq numbering belongs to the source.
  expect(fs.existsSync(path.join(testDir, `${forkId}.deltas`))).toBe(false);

  const forked = persistenceModule.loadConversation(forkId);
  const texts = forked!.messages.map((m) => ('text' in m ? m.text : undefined));
  expect(texts).toContain('settled answer');
  expect(texts.some((t) => t?.includes('never finished'))).toBe(false);
});

// --- Durability & Recovery Contract 08 Characterizations & Proofs ---

it.sequential('loadConversation: collapses an injected read failure to null without throwing', () => {
  const id = 'read-fail-null';
  const filePath = path.join(testDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
    'utf-8',
  );

  const originalReadFileSync = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((targetPath, ...args) => {
    if (typeof targetPath === 'string' && targetPath.includes(`${id}.jsonl`)) {
      const err = new Error('EACCES: permission denied');
      (err as unknown as { code: string }).code = 'EACCES';
      throw err;
    }
    return originalReadFileSync(targetPath, ...args);
  });

  let result: unknown;
  try {
    expect(() => {
      result = persistenceModule.loadConversation(id);
    }).not.toThrow();
    expect(result).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

it.sequential('deleteConversation: synchronously removes the residual delta sidecar with the canonical log', () => {
  const id = 'delete-sidecar-removal';
  fs.writeFileSync(
    path.join(testDir, `${id}.jsonl`),
    envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testDir, `${id}.deltas`),
    envelopeLine(2, { type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'streaming' }),
    'utf-8',
  );

  // Explicit user delete removes canonical log, lockfile, and residual sidecar
  // synchronously through the public persistence boundary.
  expect(persistenceModule.deleteConversation(id)).toBe(true);
  expect(fs.existsSync(path.join(testDir, `${id}.jsonl`))).toBe(false);
  expect(fs.existsSync(path.join(testDir, `${id}.deltas`))).toBe(false);
  expect(fs.existsSync(path.join(testDir, `${id}.lock`))).toBe(false);
});

it.sequential('saveLastConversation: leaves a parseable last.json file with no residual temporary files', () => {
  const id = 'last-session-clean';
  const filePath = path.join(testDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    [
      envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
      envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    ].join(''),
    'utf-8',
  );

  const stagedPaths: string[] = [];
  const origWrite = fs.writeFileSync;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((targetPath, data, options) => {
    if (
      typeof targetPath === 'string' &&
      targetPath.startsWith(testDir) &&
      targetPath !== path.join(testDir, 'last.json')
    ) {
      stagedPaths.push(targetPath);
    }
    return origWrite(targetPath, data, options);
  });

  try {
    persistenceModule.saveLastConversation(id, '/test/project/path');
  } finally {
    spy.mockRestore();
  }

  const lastJsonPath = path.join(testDir, 'last.json');
  expect(fs.existsSync(lastJsonPath)).toBe(true);
  expect(stagedPaths.length).toBeGreaterThan(0);
  for (const stagingPath of stagedPaths) {
    expect(fs.existsSync(stagingPath)).toBe(false);
  }

  const parsed = JSON.parse(fs.readFileSync(lastJsonPath, 'utf-8')) as { entries: Array<{ id: string }> };
  expect(parsed.entries.some((e) => e.id === id)).toBe(true);
});

it.sequential(
  'ensureConversationsDir: migration moves only .jsonl and last.json and does not migrate .lock or .deltas',
  () => {
    const prevLog = process.env['TERM2_TEST_LOG_DIR'];
    const prevDb = process.env['TERM2_TEST_DB_DIR'];
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-log-scope-'));
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-db-scope-'));

    try {
      fs.writeFileSync(path.join(logDir, 'valid.jsonl'), 'data', 'utf-8');
      fs.writeFileSync(path.join(logDir, 'last.json'), 'last', 'utf-8');
      fs.writeFileSync(path.join(logDir, 'active.lock'), 'lock', 'utf-8');
      fs.writeFileSync(path.join(logDir, 'interrupted.deltas'), 'deltas', 'utf-8');
      fs.writeFileSync(path.join(logDir, 'other.txt'), 'other', 'utf-8');

      process.env['TERM2_TEST_LOG_DIR'] = logDir;
      process.env['TERM2_TEST_DB_DIR'] = dbDir;
      persistenceModule.setConversationsDirForTest(dbDir);

      persistenceModule.loadConversation('trigger-migration-id');

      // Migrated files present in dbDir, absent from logDir
      expect(fs.existsSync(path.join(dbDir, 'valid.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dbDir, 'last.json'))).toBe(true);
      expect(fs.existsSync(path.join(logDir, 'valid.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(logDir, 'last.json'))).toBe(false);

      // Excluded files absent from dbDir, remain in logDir
      expect(fs.existsSync(path.join(dbDir, 'active.lock'))).toBe(false);
      expect(fs.existsSync(path.join(dbDir, 'interrupted.deltas'))).toBe(false);
      expect(fs.existsSync(path.join(dbDir, 'other.txt'))).toBe(false);
      expect(fs.existsSync(path.join(logDir, 'active.lock'))).toBe(true);
      expect(fs.existsSync(path.join(logDir, 'interrupted.deltas'))).toBe(true);
      expect(fs.existsSync(path.join(logDir, 'other.txt'))).toBe(true);
    } finally {
      if (prevLog !== undefined) process.env['TERM2_TEST_LOG_DIR'] = prevLog;
      else delete process.env['TERM2_TEST_LOG_DIR'];
      if (prevDb !== undefined) process.env['TERM2_TEST_DB_DIR'] = prevDb;
      else delete process.env['TERM2_TEST_DB_DIR'];
      fs.rmSync(logDir, { recursive: true, force: true });
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  },
);

it.sequential('loadLastConversation: unpublished last.json temp sibling is ignored', () => {
  const idA = 'sess-valid-a';
  const idB = 'sess-valid-b';
  for (const id of [idA, idB]) {
    fs.writeFileSync(
      path.join(testDir, `${id}.jsonl`),
      [
        envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z', projectPath: '/workspace' }),
        envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: `hi ${id}` } }),
      ].join(''),
      'utf-8',
    );
  }

  // Canonical last.json selects conversation A
  fs.writeFileSync(
    path.join(testDir, 'last.json'),
    JSON.stringify({ entries: [{ id: idA, updatedAt: '2026-06-01T00:00:00.000Z', projectPath: '/workspace' }] }),
    'utf-8',
  );

  // Stray unpublished temp sibling selects conversation B with a newer timestamp
  fs.writeFileSync(
    path.join(testDir, 'last.json.tmp'),
    JSON.stringify({ entries: [{ id: idB, updatedAt: '2099-01-01T00:00:00.000Z', projectPath: '/workspace' }] }),
    'utf-8',
  );

  const last = persistenceModule.loadLastConversation('/workspace');
  expect(last).toBeTruthy();
  expect(last!.id).toBe(idA);
});

it.sequential('saveLastConversation: failed rename/publish leaves previous valid last.json loadable', () => {
  const id1 = 'sess-valid-1';
  const id2 = 'sess-valid-2';
  for (const id of [id1, id2]) {
    fs.writeFileSync(
      path.join(testDir, `${id}.jsonl`),
      [
        envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z', projectPath: '/workspace' }),
        envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
      ].join(''),
      'utf-8',
    );
  }
  persistenceModule.saveLastConversation(id1, '/workspace');

  const originalRenameSync = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce((src, dst) => {
    if (typeof dst === 'string' && dst.includes('last.json')) {
      throw new Error('EPERM: operation not permitted');
    }
    return originalRenameSync(src, dst);
  });

  try {
    persistenceModule.saveLastConversation(id2, '/workspace');
  } finally {
    spy.mockRestore();
  }

  const last = persistenceModule.loadLastConversation('/workspace');
  expect(last).toBeTruthy();
  expect(last!.id).toBe(id1);
});

it.sequential('loadConversation: unreadable sidecar degrades to canonical settled conversation', () => {
  const id = 'sidecar-eisdir';
  fs.writeFileSync(
    path.join(testDir, `${id}.jsonl`),
    [
      envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
      envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
      envelopeLine(3, assistantTurn('hello settled')),
    ].join(''),
    'utf-8',
  );
  // Create sidecar as directory to force EISDIR on sidecar read
  fs.mkdirSync(path.join(testDir, `${id}.deltas`));

  const restored = persistenceModule.loadConversation(id);
  expect(restored).toBeTruthy();
  expect(restored!.messages.some((m) => m.sender === 'bot' && m.text === 'hello settled')).toBe(true);
});

it.sequential(
  'forkConversation: failed publish leaves destination untouched and unlinks temporary staging file',
  () => {
    const srcId = 'fork-publish-fail-src';
    const dstId = 'fork-publish-fail-dst';
    fs.writeFileSync(
      path.join(testDir, `${srcId}.jsonl`),
      envelopeLine(1, { type: 'session_init', id: srcId, createdAt: '2026-06-01T00:00:00.000Z' }),
      'utf-8',
    );

    const stagedPaths: string[] = [];
    const origWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((targetPath, data, options) => {
      if (
        typeof targetPath === 'string' &&
        targetPath.startsWith(testDir) &&
        targetPath.includes(dstId) &&
        targetPath.endsWith('.tmp')
      ) {
        stagedPaths.push(targetPath);
      }
      return origWrite(targetPath, data, options);
    });

    const origRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (typeof dst === 'string' && dst.includes(dstId)) {
        const err = new Error('EPERM: fork publish failed');
        (err as unknown as { code: string }).code = 'EPERM';
        throw err;
      }
      return origRename(src, dst);
    });

    try {
      expect(() => persistenceModule.forkConversation(srcId, dstId)).toThrow('EPERM: fork publish failed');
      expect(fs.existsSync(path.join(testDir, `${dstId}.jsonl`))).toBe(false);
      expect(stagedPaths.length).toBe(1);
      expect(fs.existsSync(stagedPaths[0]!)).toBe(false);
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
  },
);

it.sequential(
  'loadConversationForProject: isolates sessions by sshHost when matching or differing from expected host',
  () => {
    const id = 'ssh-isolation-sess';
    const filePath = path.join(testDir, `${id}.jsonl`);
    fs.writeFileSync(
      filePath,
      [
        envelopeLine(1, {
          type: 'session_init',
          id,
          createdAt: '2026-06-01T00:00:00.000Z',
          projectPath: '/workspace',
          sshHost: 'user@remote-box-1',
        }),
        envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'ssh command' } }),
      ].join(''),
      'utf-8',
    );

    // Matching project path but differing sshHost returns project_mismatch
    const mismatchResult = persistenceModule.loadConversationForProject(id, '/workspace', 'user@remote-box-2');
    expect(mismatchResult).toMatchObject({ status: 'project_mismatch' });

    // Matching project path with missing sshHost when conversation is remote returns project_mismatch
    const localMismatchResult = persistenceModule.loadConversationForProject(id, '/workspace', undefined);
    expect(localMismatchResult).toMatchObject({ status: 'project_mismatch' });

    // Matching project path and exact sshHost returns loaded
    const loadedResult = persistenceModule.loadConversationForProject(id, '/workspace', 'user@remote-box-1');
    expect(loadedResult).toMatchObject({ status: 'loaded' });
    if (loadedResult.status === 'loaded') {
      expect(loadedResult.conversation.id).toBe(id);
      expect(loadedResult.conversation.sshHost).toBe('user@remote-box-1');
    }
  },
);

// Retained red defect proofs:

it.sequential(
  'loadConversationForProject: returns a typed unreadable result when read fails instead of propagating raw fs error',
  () => {
    const id = 'proj-read-failure';
    const filePath = path.join(testDir, `${id}.jsonl`);
    fs.writeFileSync(
      filePath,
      envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
      'utf-8',
    );

    const originalReadFileSync = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((targetPath, ...args) => {
      if (typeof targetPath === 'string' && targetPath.includes(`${id}.jsonl`)) {
        const err = new Error('EACCES: permission denied');
        (err as unknown as { code: string }).code = 'EACCES';
        throw err;
      }
      return originalReadFileSync(targetPath, ...args);
    });

    try {
      // D1 invariant: read errors must not escape raw; must return a distinct typed unreadable status and error
      const result = persistenceModule.loadConversationForProject(id, '/test/project');
      expect(result).toMatchObject({
        status: 'unreadable',
        error: expect.anything(),
      });
    } finally {
      spy.mockRestore();
    }
  },
);

it.sequential('saveLastConversation: uses a distinct temporary staging path for each save call', () => {
  const id1 = 'sess-1';
  const id2 = 'sess-2';
  for (const id of [id1, id2]) {
    fs.writeFileSync(
      path.join(testDir, `${id}.jsonl`),
      [
        envelopeLine(1, { type: 'session_init', id, createdAt: '2026-06-01T00:00:00.000Z' }),
        envelopeLine(2, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
      ].join(''),
      'utf-8',
    );
  }

  const tempWrites: string[] = [];
  const origWrite = fs.writeFileSync;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((targetPath, data, options) => {
    if (
      typeof targetPath === 'string' &&
      targetPath.startsWith(testDir) &&
      targetPath !== path.join(testDir, 'last.json')
    ) {
      tempWrites.push(targetPath);
    }
    return origWrite(targetPath, data, options);
  });

  try {
    persistenceModule.saveLastConversation(id1, '/proj-1');
    persistenceModule.saveLastConversation(id2, '/proj-2');

    expect(tempWrites.length).toBe(2);
    // D3 invariant: temp staging file path for last.json writes must be distinct per call/process
    // rather than colliding on a fixed path
    expect(tempWrites[0]).not.toBe(tempWrites[1]);
  } finally {
    spy.mockRestore();
  }
});

it.sequential('isConversationLocked: diagnostically distinguishes corrupt lockfile payload from live lock', () => {
  const id = 'corrupt-lock-sess';
  const lockFilePath = path.join(testDir, `${id}.lock`);
  fs.writeFileSync(lockFilePath, '{corrupt-json-payload', 'utf-8');

  // D4 invariant: corrupt lockfile must return a discriminated status/result indicating corruption
  // rather than masquerading as a live lock ({ pid: -1 }) or evaluating as unlocked (null)
  const lockInfo = persistenceModule.isConversationLocked(id);
  expect(lockInfo).toMatchObject({ status: 'corrupt' });
});

it.sequential('isConversationLocked: reports stale for a same-host lock whose PID is demonstrably dead', () => {
  const id = 'stale-lock-sess';
  fs.writeFileSync(
    path.join(testDir, `${id}.lock`),
    JSON.stringify({ pid: 424242, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
    'utf-8',
  );

  // Deterministic liveness control: an injected check reports every PID dead, so
  // this proof never probes a real process.
  persistenceModule.setPidAlivenessCheckForTest(() => false);
  try {
    const lockInfo = persistenceModule.isConversationLocked(id);
    expect(lockInfo).toMatchObject({
      status: 'stale',
      pid: 424242,
      startedAt: '2026-06-01T00:00:00.000Z',
      host: os.hostname(),
    });
  } finally {
    persistenceModule.setPidAlivenessCheckForTest(null);
  }
});

it.sequential(
  'isConversationLocked: same-host lock whose PID was reaped is stale through the production liveness path',
  async () => {
    const id = 'stale-lock-reaped-sess';
    // Spawn and fully reap a real child so the lock records a PID that is provably
    // dead. The production default liveness probe signals only this controlled PID.
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });

    fs.writeFileSync(
      path.join(testDir, `${id}.lock`),
      JSON.stringify({ pid: deadPid, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
      'utf-8',
    );

    expect(persistenceModule.isPidAlive(deadPid)).toBe(false);
    expect(persistenceModule.isConversationLocked(id)).toMatchObject({ status: 'stale', pid: deadPid });
  },
);

it.sequential('isConversationLocked: reports held for a same-host lock whose PID is alive', () => {
  const id = 'held-lock-sess';
  fs.writeFileSync(
    path.join(testDir, `${id}.lock`),
    JSON.stringify({ pid: process.pid, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
    'utf-8',
  );

  const lockInfo = persistenceModule.isConversationLocked(id);
  expect(lockInfo).toMatchObject({ status: 'held', pid: process.pid, host: os.hostname() });
});

it.sequential('isConversationLocked: cross-host lock is reported held even with an unprovable PID', () => {
  const id = 'remote-lock-sess';
  fs.writeFileSync(
    path.join(testDir, `${id}.lock`),
    JSON.stringify({ pid: 424242, startedAt: '2026-06-01T00:00:00.000Z', host: 'some-other-host' }),
    'utf-8',
  );

  // Liveness cannot be proven for a foreign host; the lock is treated as held.
  const lockInfo = persistenceModule.isConversationLocked(id);
  expect(lockInfo).toMatchObject({ status: 'held', pid: 424242, host: 'some-other-host' });
});
