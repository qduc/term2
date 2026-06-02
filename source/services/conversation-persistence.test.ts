import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter, LockConflictError } from './conversation-log-writer.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import { ConversationSession } from './conversation-session.js';
import { createMockSettingsService } from './settings-service.mock.js';

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
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'hi there' }] },
    state: { previousResponseId: 'resp-1', model: 'gpt-4o', provider: 'openai' },
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
  writer.append(assistantTurn('done'));
  // Second turn: user submits, tool starts, then crash
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'more' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: {} });
  void writer.close();

  const restored = persistenceModule.loadConversation(id);
  t.truthy(restored);
  t.true(restored!.replayWarnings.some((w) => w.includes('interrupted')));

  // The interrupted system message is on UI messages
  t.true(restored!.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted')));
});

test.serial('replay: user_message only with no assistant_turn flags interruption', (t) => {
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
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
    state: { previousResponseId: null, model: 'gpt-5' },
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
  writer.append(assistantTurn('A'));
  writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'second' } });
  writer.append(assistantTurn('B', 'r2'));
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
  writer.append(assistantTurn('A'));
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

test.serial('listConversations: filters sessions by workspace and ssh host', (t) => {
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
  t.is(listP1Local.length, 1);
  t.is(listP1Local[0].id, id1);

  // Filter for remote /workspace/p1 on host1
  const listP1Host1 = persistenceModule.listConversations('/workspace/p1', 'host1');
  t.is(listP1Host1.length, 1);
  t.is(listP1Host1[0].id, id3);

  // Filter for /workspace/p2
  const listP2Local = persistenceModule.listConversations('/workspace/p2');
  t.is(listP2Local.length, 1);
  t.is(listP2Local[0].id, id2);
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

test.serial('hasConversationContent: returns true for assistant_turn', (t) => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append(assistantTurn('hello'));
  void writer.close();
  t.true(persistenceModule.hasConversationContent(id));
});

test.serial('hasConversationContent: ignores unsupported assistant_final events', (t) => {
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
  t.false(persistenceModule.hasConversationContent(id));
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

test.serial('subagent_completed and corresponding records omit nestedRunResult', (t) => {
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
  t.truthy(completedEnv);
  t.is(completedEnv.event.result.status, 'completed');
  t.is(completedEnv.event.result.finalText, 'Task resolved successfully');
  t.deepEqual(completedEnv.event.result.filesChanged, ['src/app.ts']);
  t.is(completedEnv.event.result.nestedRunResult, undefined);

  // Find tool_result
  const toolResultEnv = envelopes.find((env) => env.event?.type === 'tool_result');
  t.truthy(toolResultEnv);
  t.is(toolResultEnv.event.toolName, 'run_subagent');
  const parsedOutput = JSON.parse(toolResultEnv.event.output);
  t.is(parsedOutput.status, 'completed');
  t.is(parsedOutput.finalText, 'Result text');
  t.is(parsedOutput.nestedRunResult, undefined);

  // Find assistant_turn and check turn items
  const turnEnv = envelopes.find((env) => env.event?.type === 'assistant_turn');
  t.truthy(turnEnv);
  const turnOutput = JSON.parse(turnEnv.event.turn.items[0].output);
  t.is(turnOutput.status, 'completed');
  t.is(turnOutput.finalText, 'Turn result text');
  t.is(turnOutput.nestedRunResult, undefined);
});

test.serial('saveLastConversation: stores per-project last conversation', (t) => {
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
  t.truthy(lastA);
  t.is(lastA!.id, id1);

  const lastB = persistenceModule.loadLastConversation('/project-b');
  t.truthy(lastB);
  t.is(lastB!.id, id2);
});

test.serial('saveLastConversation: stores per-ssh-host last conversation', (t) => {
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
  t.truthy(lastA);
  t.is(lastA!.id, id1);

  const lastB = persistenceModule.loadLastConversation('/remote', 'host-b');
  t.truthy(lastB);
  t.is(lastB!.id, id2);
});

test.serial('loadLastConversation: falls back to scanning when no last.json entry matches', (t) => {
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
  t.truthy(last);
  t.is(last!.id, id);
});

test.serial('loadLastConversation: migrates old last.json format', (t) => {
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
  t.truthy(last);
  t.is(last!.id, id);
});

test.serial('deleteConversation: removes only matching entry from last.json', (t) => {
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

  t.true(persistenceModule.deleteConversation(id1));
  t.false(fs.existsSync(path.join(testDir, `${id1}.jsonl`)));
  t.true(fs.existsSync(path.join(testDir, 'last.json')));

  const lastB = persistenceModule.loadLastConversation('/project-b');
  t.truthy(lastB);
  t.is(lastB!.id, id2);
});

test.serial('saveLastConversation: updates entry when projectPath changes for same id', (t) => {
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

  t.is(persistenceModule.loadLastConversation('/old-path'), null);

  const lastNew = persistenceModule.loadLastConversation('/new-path');
  t.truthy(lastNew);
  t.is(lastNew!.id, id);
});

// Suppress unused-event-import lint
const _ev: LogEvent | null = null;
void _ev;

test.serial('writer + loadConversation: round-trips a v2 conversation with assistant_turn', (t) => {
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
  t.truthy(restored);
  t.is(restored!.id, id);
  t.is(restored!.previousResponseId, 'resp-v2');
  // Reasoning is reconstructed as a standalone history item (matching the live SDK
  // output), NOT folded into the following tool_call's providerData. Folding caused
  // the reasoning_content to be serialized onto both the assistant message and the
  // tool call (duplicate reasoning_content) by the chat-completions converter.
  t.is(restored!.history.length, 5);
  t.deepEqual(restored!.history[0], { role: 'user', type: 'message', content: 'run tool' });
  t.deepEqual(restored!.history[1], {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'thinking about ls' }],
    rawContent: [{ type: 'reasoning_text', text: 'thinking about ls' }],
  });
  t.deepEqual(restored!.history[2], {
    type: 'function_call',
    callId: 'call-v2',
    name: 'shell',
    arguments: 'ls',
  });
  t.deepEqual(restored!.history[3], {
    type: 'function_call_result',
    callId: 'call-v2',
    name: 'shell',
    output: 'file.txt',
  });
  t.deepEqual(restored!.history[4], {
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'here is the file' }],
  });
  t.is(restored!.toolLedger.length, 1);
  t.is(restored!.toolLedger[0].callId, 'call-v2');

  // exact messages ordering: user, reasoning, command, bot
  t.is(restored!.messages.length, 4);
  t.is(restored!.messages[0].sender, 'user');
  t.is(restored!.messages[1].sender, 'reasoning');
  t.is(restored!.messages[1].text, 'thinking about ls');
  t.is(restored!.messages[2].sender, 'command');
  t.is(restored!.messages[2].status, 'completed');
  t.is(restored!.messages[3].sender, 'bot');
  t.is(restored!.messages[3].text, 'here is the file');
});

test.serial('session logging writes compact v3 assistant_turn state without cumulative snapshot', async (t) => {
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
  const session = new ConversationSession(id, {
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
  session.setLogSink((event) => writer.append(event));

  const result = await session.sendMessage('hello');
  t.is(result.type, 'response');
  await writer.close();

  const filePath = path.join(testDir, `${id}.jsonl`);
  const envelopes = fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turnEnvelope = envelopes.find((env) => env.event?.type === 'assistant_turn');

  t.truthy(turnEnvelope);
  t.is(turnEnvelope.v, 3);
  t.deepEqual(turnEnvelope.event.state, {
    previousResponseId: 'resp-v3',
    model: 'gpt-5',
    provider: 'openai',
  });
  t.is(turnEnvelope.event.displayUsage, undefined);
  t.is(turnEnvelope.event.snapshot, undefined);
  t.is(turnEnvelope.event.turn.items.length, 1);
  t.is(turnEnvelope.event.turn.items[0].text, 'Done.');
});

test.serial('session logging persists displayUsage separately from cumulative assistant_turn usage', async (t) => {
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

  const session = new ConversationSession(id, {
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

  (session as any).shellAutoApproval = {
    resolveAdvisoryForInterruption: async () => ({ model: 'gpt-5', reasoning: 'allow', decision: 'approve' }),
    shouldAutoApprove: () => true,
    clearCache: () => {},
  };

  session.setLogSink((event) => writer.append(event));

  await session.sendMessage('hello');
  await writer.close();

  const filePath = path.join(testDir, `${id}.jsonl`);
  const envelopes = fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turnEnvelope = envelopes.find((env) => env.event?.type === 'assistant_turn');

  t.truthy(turnEnvelope);
  t.deepEqual(turnEnvelope.event.usage, { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 });
  t.deepEqual(turnEnvelope.event.displayUsage, { prompt_tokens: 175, completion_tokens: 18, total_tokens: 193 });
});

test.serial('replay: interrupted v2 logs without assistant_turn still recover from coarse events', (t) => {
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
  t.truthy(restored);
  t.true(restored!.replayWarnings.some((w) => w.includes('interrupted')));
  t.is(restored!.messages.length, 3); // user, command, system interrupted warning
  t.is(restored!.messages[0].sender, 'user');
  t.is(restored!.messages[1].sender, 'command');
  t.is(restored!.messages[1].status, 'completed');
  t.is(restored!.messages[2].sender, 'system');
});

test.serial(
  'session logging with auto-approved tool continuation writes only one assistant_turn containing all details',
  async (t) => {
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

    const session = new ConversationSession(id, {
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

    // Inject a mock shellAutoApproval resolver that auto-approves
    (session as any).shellAutoApproval = {
      resolveAdvisoryForInterruption: async () => ({ model: 'gpt-5', reasoning: 'allow', decision: 'approve' }),
      shouldAutoApprove: () => true,
      clearCache: () => {},
    };

    session.setLogSink((event) => writer.append(event));

    const result = await session.sendMessage('hello');
    t.is(result.type, 'response');
    t.true(continueCalled);
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
    t.is(assistantTurnEnvelopes.length, 1);

    const turnEvent = assistantTurnEnvelopes[0].event;
    t.truthy(turnEvent);
    t.is(turnEvent.turn.items.length, 3); // tool_call, tool_result, assistant_text

    t.is(turnEvent.turn.items[0].type, 'tool_call');
    t.is(turnEvent.turn.items[0].callId, 'call-1');
    t.is(turnEvent.turn.items[1].type, 'tool_result');
    t.is(turnEvent.turn.items[1].callId, 'call-1');
    t.is(turnEvent.turn.items[2].type, 'assistant_text');
    t.is(turnEvent.turn.items[2].text, 'Done continuation.');
  },
);

test.serial('ensureConversationsDir: automatically migrates files from log to data directory', (t) => {
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
    t.true(fs.existsSync(path.join(dbDir, testFile1)));
    t.true(fs.existsSync(path.join(dbDir, testFile2)));
    t.false(fs.existsSync(path.join(dbDir, otherFile))); // Unrelated files should not be migrated
    t.false(fs.existsSync(path.join(logDir, testFile1)));
    t.false(fs.existsSync(path.join(logDir, testFile2)));

    t.is(fs.readFileSync(path.join(dbDir, testFile1), 'utf-8'), 'envelope 1');
    t.is(fs.readFileSync(path.join(dbDir, testFile2), 'utf-8'), 'last data');
  } finally {
    // Cleanup
    delete process.env['TERM2_TEST_LOG_DIR'];
    delete process.env['TERM2_TEST_DB_DIR'];
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test.serial('ensureConversationsDir: migrated conversations are not resurrected after deletion', (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-log-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-db-'));

  try {
    const migratedId = 'migrated-session';
    fs.writeFileSync(path.join(logDir, `${migratedId}.jsonl`), 'stub', 'utf-8');

    process.env['TERM2_TEST_LOG_DIR'] = logDir;
    process.env['TERM2_TEST_DB_DIR'] = dbDir;
    persistenceModule.setConversationsDirForTest(dbDir);

    persistenceModule.loadConversation('non-existent-id');
    t.true(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`)));

    t.true(persistenceModule.deleteConversation(migratedId));
    t.false(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`)));

    persistenceModule.loadConversation('another-non-existent-id');
    t.false(fs.existsSync(path.join(dbDir, `${migratedId}.jsonl`)));
    t.false(fs.existsSync(path.join(logDir, `${migratedId}.jsonl`)));
  } finally {
    delete process.env['TERM2_TEST_LOG_DIR'];
    delete process.env['TERM2_TEST_DB_DIR'];
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
