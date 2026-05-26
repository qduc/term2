import test from 'ava';
import { LOG_ENVELOPE_VERSION, type LogEnvelope, type LogEvent } from './conversation-log-events.js';
import { replayEvents } from './conversation-replay.js';

let seq = 0;
function env(event: LogEvent): LogEnvelope {
  return { v: LOG_ENVELOPE_VERSION, seq: ++seq, ts: new Date().toISOString(), event };
}

test.beforeEach(() => {
  seq = 0;
});

test('replayEvents: empty log produces empty state with no warnings', (t) => {
  const restored = replayEvents([]);
  t.is(restored.id, '');
  t.is(restored.history.length, 0);
  t.is(restored.messages.length, 0);
  t.deepEqual(restored.replayWarnings, []);
});

test('replayEvents: session_init populates session metadata', (t) => {
  const envelopes: LogEnvelope[] = [
    env({
      type: 'session_init',
      id: 'sess-1',
      createdAt: '2026-01-01T00:00:00Z',
      projectPath: '/p',
      sshHost: 'h',
      model: 'gpt-5',
      provider: 'openai',
      reasoningEffort: 'high',
    }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.id, 'sess-1');
  t.is(restored.projectPath, '/p');
  t.is(restored.sshHost, 'h');
  t.is(restored.model, 'gpt-5');
  t.is(restored.provider, 'openai');
  t.is(restored.reasoningEffort, 'high');
});

test('replayEvents: assistant_final snapshot replaces history', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    env({
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
      finalText: 'ok',
      snapshot: {
        history: [{ role: 'user', type: 'message', content: 'hi' } as any],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.history.length, 1);
  t.is(restored.previousResponseId, 'r1');
  t.is(restored.messages.length, 2);
});

test('replayEvents: cross-model invalidation nulls previousResponseId', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', model: 'gpt-4o' }),
    env({
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
      finalText: 'ok',
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [], model: 'gpt-5' },
    }),
    env({ type: 'settings_changed', key: 'agent.model', value: 'gpt-4o' }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.previousResponseId, null);
});

test('replayEvents: trailing user_message inserts interrupted system message', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
  ];
  const restored = replayEvents(envelopes);
  t.true(restored.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted')));
  t.true(restored.replayWarnings.length > 0);
});

test('replayEvents: tool_started followed by tool_result clears in-flight (no warning)', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'ok' }),
    env({
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'done' },
      finalText: 'done',
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.replayWarnings.length, 0);
});

test('replayEvents: subagent_started + subagent_completed cleans up activity message and accumulates usage', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'subagent_started', agentId: 'a1', role: 'explorer', task: 'find x' }),
    env({
      type: 'subagent_completed',
      result: {
        agentId: 'a1',
        role: 'explorer',
        status: 'completed',
        finalText: 'done',
        filesChanged: [],
        toolsUsed: [],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } as any,
      },
    }),
    env({
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'all done' },
      finalText: 'all done',
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];
  const restored = replayEvents(envelopes);
  t.false(restored.messages.some((m) => m.sender === 'subagent'));
  t.truthy(restored.subagentUsage);
});

test('replayEvents: unknown event type is ignored gracefully', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    { v: LOG_ENVELOPE_VERSION, seq: 99, ts: '', event: { type: 'made_up_event' } as any },
    env({
      type: 'assistant_final',
      message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
      finalText: 'ok',
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.previousResponseId, 'r1');
});
