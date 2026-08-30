import { it, expect, beforeEach } from 'vitest';
import { LOG_ENVELOPE_VERSION, type LogEnvelope, type LogEvent } from '../logging/conversation-log-events.js';
import { auditSessionLog, formatSessionAudit } from './session-audit.js';
import { replayEvents } from './conversation-replay.js';

let seq = 0;
function env(event: LogEvent): LogEnvelope {
  return { v: LOG_ENVELOPE_VERSION, seq: ++seq, ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`, event };
}

beforeEach(() => {
  seq = 0;
});

const userMessage = (text: string): LogEvent => ({
  type: 'user_message',
  message: { id: `u-${text}`, sender: 'user', text } as any,
});

const assistantTurn = (text: string): LogEvent => ({
  type: 'assistant_turn',
  turn: { items: [{ type: 'assistant_text', text }] } as any,
});

it('auditSessionLog: an empty log reports the empty outcome', () => {
  const audit = auditSessionLog([]);
  expect(audit.outcome).toBe('empty');
  expect(audit.userTurns).toBe(0);
  expect(audit.firstEventAt).toBeUndefined();
});

it('auditSessionLog: a completed turn settles', () => {
  const audit = auditSessionLog([
    env({ type: 'session_init', id: 'sess-1', createdAt: '2026-01-01T00:00:00Z' }),
    env(userMessage('hello')),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed' }),
    env(assistantTurn('done')),
  ]);

  expect(audit.outcome).toBe('settled');
  expect(audit.sessionId).toBe('sess-1');
  expect(audit.userTurns).toBe(1);
  expect(audit.assistantTurns).toBe(1);
  expect(audit.toolCalls).toEqual({ started: 1, completed: 1, failed: 0, aborted: 0, unknown: 0 });
  expect(audit.unfinishedToolCalls).toEqual([]);
});

it('auditSessionLog: a tool dispatched before the process died is reported unfinished', () => {
  const audit = auditSessionLog([
    env(userMessage('build it')),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_started', toolCallId: 'c2', toolName: 'create_file', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed' }),
  ]);

  expect(audit.outcome).toBe('interrupted_mid_tool');
  expect(audit.unfinishedToolCalls).toEqual([{ callId: 'c2', toolName: 'create_file' }]);
});

it('auditSessionLog: an unanswered approval outranks the dangling call it created', () => {
  const audit = auditSessionLog([
    env(userMessage('deploy')),
    env({ type: 'approval_required', approval: { callId: 'c1', toolName: 'shell', argumentsText: 'rm -rf x' } }),
  ]);

  // The call is in flight either way, but the reason the session stalled is a
  // human who never answered, not a crash.
  expect(audit.outcome).toBe('awaiting_approval');
  expect(audit.unfinishedToolCalls).toEqual([{ callId: 'c1', toolName: 'shell' }]);
});

it('auditSessionLog: a resolved approval no longer counts as awaiting', () => {
  const audit = auditSessionLog([
    env(userMessage('deploy')),
    env({ type: 'approval_required', approval: { callId: 'c1', toolName: 'shell' } }),
    env({ type: 'approval_resolved', answer: 'y' }),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
  ]);

  expect(audit.outcome).toBe('interrupted_mid_tool');
});

it('auditSessionLog: a user turn with no reply is interrupted mid turn', () => {
  const audit = auditSessionLog([env(userMessage('first')), env(assistantTurn('ok')), env(userMessage('second'))]);
  expect(audit.outcome).toBe('interrupted_mid_turn');
});

it('auditSessionLog: an assistant turn clears earlier in-flight bookkeeping', () => {
  const audit = auditSessionLog([
    env(userMessage('go')),
    env({ type: 'approval_required', approval: { callId: 'c1', toolName: 'shell' } }),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env(assistantTurn('finished')),
  ]);

  expect(audit.outcome).toBe('settled');
  expect(audit.unfinishedToolCalls).toEqual([]);
});

it('auditSessionLog: unknown tool status is counted apart from success and failure', () => {
  const audit = auditSessionLog([
    env(userMessage('go')),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'unknown' }),
    env(assistantTurn('done')),
  ]);

  expect(audit.toolCalls.unknown).toBe(1);
  expect(audit.toolCalls.completed).toBe(0);
});

it('auditSessionLog: open subagents, shells, errors and truncation are surfaced', () => {
  const audit = auditSessionLog([
    env(userMessage('go')),
    env({ type: 'subagent_started', agentId: 'a1', role: 'worker', task: 't' }),
    env({ type: 'subagent_started', agentId: 'a2', role: 'explorer', task: 't' }),
    env({ type: 'subagent_completed', result: { agentId: 'a1', role: 'worker' } as any }),
    env({ type: 'background_shell_started', jobId: 'j1', command: 'pnpm test' }),
    env({ type: 'error', message: 'stream failed', kind: 'transport' }),
    {
      v: LOG_ENVELOPE_VERSION,
      seq: 99,
      ts: '2026-01-01T00:01:00Z',
      event: { type: 'assistant_turn', truncated: true, originalSize: 500000 },
    },
    env(assistantTurn('done')),
  ]);

  expect(audit.unfinishedSubagents).toEqual([{ agentId: 'a2', role: 'explorer' }]);
  expect(audit.unfinishedBackgroundShells).toEqual([{ jobId: 'j1', command: 'pnpm test' }]);
  expect(audit.errors).toEqual([{ message: 'stream failed', kind: 'transport' }]);
  expect(audit.truncatedEvents).toBe(1);
});

it('auditSessionLog: agrees with replayEvents about which calls were left unpaid', () => {
  const envelopes = [
    env({ type: 'session_init', id: 'sess-x', createdAt: '2026-01-01T00:00:00Z' }),
    env(userMessage('go')),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed' }),
    env({ type: 'tool_started', toolCallId: 'c2', toolName: 'create_file', arguments: {} }),
  ];

  const audit = auditSessionLog(envelopes);
  const restored = replayEvents(envelopes);

  // Replay marks exactly the unpaid calls aborted on recovery; the audit must
  // name the same set without resuming anything.
  const abortedByReplay = restored.toolLedger
    .filter((entry) => entry.status === 'aborted' && entry.failureReason === 'Session ended unexpectedly')
    .map((entry) => entry.callId)
    .sort();

  expect(abortedByReplay).toEqual(['c2']);
  expect(audit.unfinishedToolCalls.map((c) => c.callId).sort()).toEqual(abortedByReplay);
});

it('formatSessionAudit: renders the verdict and the unfinished work', () => {
  const audit = auditSessionLog([
    env(userMessage('go')),
    env({ type: 'tool_started', toolCallId: 'c2', toolName: 'create_file', arguments: {} }),
  ]);

  const text = formatSessionAudit(audit);
  expect(text).toContain('interrupted_mid_tool');
  expect(text).toContain('unfinished tool: create_file (c2)');
});

it('auditSessionLog: undo clears trailing user message and in-flight calls', () => {
  const audit = auditSessionLog([
    env(userMessage('build it')),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'approval_required', approval: { callId: 'c2', toolName: 'shell' } }),
    env({ type: 'undo' } as any),
  ]);

  expect(audit.outcome).toBe('settled');
  expect(audit.unfinishedToolCalls).toEqual([]);
});

it('auditSessionLog: subagent transfer/interruption and background shell completion retire open tasks', () => {
  const audit = auditSessionLog([
    env(userMessage('run workers')),
    env({ type: 'subagent_started', agentId: 'sub-1', role: 'worker-1', task: 't1' }),
    env({ type: 'subagent_started', agentId: 'sub-2', role: 'worker-2', task: 't2' }),
    env({ type: 'subagent_transferred', agentId: 'sub-1', runId: 'r1', role: 'worker-1' }),
    env({ type: 'subagent_interrupted', agentId: 'sub-2', role: 'worker-2', finalText: 'stopped' }),
    env({ type: 'background_shell_started', jobId: 'shell-1', command: 'npm start' }),
    env({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'npm start',
      status: 'completed',
      output: 'ok',
    }),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'test', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'test', status: 'failed', output: 'err' }),
    env({ type: 'tool_started', toolCallId: 'c2', toolName: 'test', arguments: {} }),
    env({ type: 'tool_result', callId: 'c2', toolName: 'test', status: 'aborted' }),
    env(assistantTurn('finished')),
  ]);

  expect(audit.unfinishedSubagents).toEqual([]);
  expect(audit.unfinishedBackgroundShells).toEqual([]);
  expect(audit.toolCalls.failed).toBe(1);
  expect(audit.toolCalls.aborted).toBe(1);
  expect(audit.outcome).toBe('settled');
});
