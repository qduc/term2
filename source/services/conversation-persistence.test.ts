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

  // 3. Log assistant_final event with nestedRunResult in snapshot
  writer.append({
    type: 'assistant_final',
    message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'all done' },
    finalText: 'all done',
    snapshot: {
      history: [
        {
          role: 'tool',
          type: 'function_call_result',
          name: 'run_subagent',
          output: JSON.stringify({
            status: 'completed',
            finalText: 'Snapshot result text',
            nestedRunResult: { state: { internalStuff: 'hidden' } },
          }),
        } as any,
      ],
      previousResponseId: 'resp-1',
      toolLedger: [
        {
          turnId: 'turn-1',
          callId: 'call-subagent-1',
          toolName: 'run_subagent',
          status: 'completed',
          startedAt: '2026-05-26T00:00:00.000Z',
          output: {
            status: 'completed',
            nestedRunResult: { state: { internalStuff: 'hidden' } },
          },
        } as any,
      ],
    },
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

  // Find assistant_final and check snapshot
  const finalEnv = envelopes.find((env) => env.event?.type === 'assistant_final');
  t.truthy(finalEnv);
  const snapHistoryOutput = JSON.parse(finalEnv.event.snapshot.history[0].output);
  t.is(snapHistoryOutput.status, 'completed');
  t.is(snapHistoryOutput.finalText, 'Snapshot result text');
  t.is(snapHistoryOutput.nestedRunResult, undefined);

  t.is(finalEnv.event.snapshot.toolLedger[0].output.status, 'completed');
  t.is(finalEnv.event.snapshot.toolLedger[0].output.nestedRunResult, undefined);
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
