import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter, LockConflictError } from '../logging/conversation-log-writer.js';
import type { LogEvent, StateSnapshot } from '../logging/conversation-log-events.js';
import { createConversationSession } from '../session/session-composition.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

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
afterEach(cleanupAll);
afterEach(() => {
  persistenceModule.setConversationsDirForTest(null);
  testDir = '';
});

it.sequential('generateId: returns a valid UUID', () => {
  const id = persistenceModule.generateId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

it.sequential('generateId: returns unique IDs', () => {
  expect(persistenceModule.generateId()).not.toBe(persistenceModule.generateId());
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
  expect(() => w2.init({ id, createdAt: '2026-05-26T00:00:00.000Z' }));
  await w2.close();
});

it.sequential('forkConversation: copies the source jsonl to a new id', () => {
  const srcId = persistenceModule.generateId();
  const dstId = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: srcId, dir: testDir, logger: stubLogger });
  writer.init({ id: srcId, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append(assistantTurn('A'));
  void writer.close();

  expect(persistenceModule.forkConversation(srcId, dstId)).toBe(true);
  const restored = persistenceModule.loadConversation(dstId);
  expect(restored!.previousResponseId).toBe('r1');
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
        { type: 'reasoning', text: 'thinking about ls' },
        { type: 'tool_call', callId: 'call-v2', toolName: 'shell', arguments: 'ls' },
        { type: 'tool_result', callId: 'call-v2', toolName: 'shell', status: 'completed', output: 'file.txt' },
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
    output: 'file.txt',
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
  expect(restored!.messages[1].text).toBe('thinking about ls');
  expect(restored!.messages[2].sender).toBe('command');
  expect(restored!.messages[2].status).toBe('completed');
  expect(restored!.messages[3].sender).toBe('bot');
  expect(restored!.messages[3].text).toBe('here is the file');
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
    {
      type: 'response.done',
      response: {
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
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
    {
      type: 'response.done',
      response: {
        usage: { input_tokens: 175, output_tokens: 18 },
      },
    },
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
  expect(restored!.messages[1].status).toBe('completed');
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
