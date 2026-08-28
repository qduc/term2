import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';

const stubLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  getCorrelationId: () => undefined,
} as any;

let testDir = '';

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-audit-test-'));
  persistenceModule.setConversationsDirForTest(testDir);
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  persistenceModule.setConversationsDirForTest(null);
  testDir = '';
});

it.sequential('auditConversation: returns null for a conversation that does not exist', () => {
  expect(persistenceModule.auditConversation('no-such-session')).toBeNull();
});

it.sequential('auditConversation: a log written by the real writer and closed cleanly settles', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } });
  writer.append({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'pwd' } });
  writer.append({ type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/tmp' });
  writer.append({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'done' }] } as any });
  void writer.close();

  const audit = persistenceModule.auditConversation(id);
  expect(audit).toBeTruthy();
  expect(audit!.sessionId).toBe(id);
  expect(audit!.outcome).toBe('settled');
  expect(audit!.toolCalls.completed).toBe(1);
});

it.sequential('auditConversation: a real log that stops after tool dispatch reads as interrupted', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run the build' } });
  writer.append({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'pnpm build' },
  });
  // No tool_result and no assistant_turn: the process never got that far.
  void writer.close();

  const audit = persistenceModule.auditConversation(id);
  expect(audit!.outcome).toBe('interrupted_mid_tool');
  expect(audit!.unfinishedToolCalls).toEqual([{ callId: 'call-1', toolName: 'shell' }]);

  // The same log resumed marks that call aborted, so the two agree.
  const restored = persistenceModule.loadConversation(id);
  const aborted = restored!.toolLedger.filter((e) => e.status === 'aborted').map((e) => e.callId);
  expect(aborted).toEqual(['call-1']);
});

it.sequential('auditConversation: a real log parked on an approval reads as awaiting approval', () => {
  const id = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({ id, createdAt: '2026-05-26T00:00:00.000Z' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'deploy' } });
  writer.append({
    type: 'approval_required',
    approval: { callId: 'call-9', toolName: 'shell', argumentsText: 'deploy.sh' },
  });
  void writer.close();

  const audit = persistenceModule.auditConversation(id);
  expect(audit!.outcome).toBe('awaiting_approval');
});
