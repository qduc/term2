import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { LOG_ENVELOPE_VERSION, type LogEnvelope, type LogEvent } from '../logging/conversation-log-events.js';
import { replayEvents } from './conversation-replay.js';

let seq = 0;
function env(event: LogEvent): LogEnvelope {
  return { v: LOG_ENVELOPE_VERSION, seq: ++seq, ts: new Date().toISOString(), event };
}

beforeEach(() => {
  seq = 0;
});

it('replayEvents: empty log produces empty state with no warnings', () => {
  const restored = replayEvents([]);
  expect(restored.id).toBe('');
  expect(restored.history.length).toBe(0);
  expect(restored.messages.length).toBe(0);
  expect(restored.replayWarnings).toEqual([]);
});

it('replayEvents: session_init populates session metadata', () => {
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
  expect(restored.id).toBe('sess-1');
  expect(restored.projectPath).toBe('/p');
  expect(restored.sshHost).toBe('h');
  expect(restored.model).toBe('gpt-5');
  expect(restored.provider).toBe('openai');
  expect(restored.reasoningEffort).toBe('high');
});

it('replayEvents: unsupported assistant_final is ignored', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    {
      v: 1,
      seq: 2,
      ts: new Date().toISOString(),
      event: {
        type: 'assistant_final',
        message: { id: 'b1', sender: 'bot', status: 'finalized', text: 'ok' },
        finalText: 'ok',
        snapshot: {
          history: [{ role: 'user', type: 'message', content: 'hi' } as any],
          previousResponseId: 'r1',
          toolLedger: [],
        },
      } as any,
    },
  ];
  const restored = replayEvents(envelopes);
  expect(restored.history.length).toBe(0);
  expect(restored.previousResponseId).toBe(null);
  expect(restored.messages.length).toBe(0);
});

it('replayEvents: cross-model invalidation nulls previousResponseId', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', model: 'gpt-4o' }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
      state: { previousResponseId: 'r1', model: 'gpt-5' },
    }),
    env({ type: 'settings_changed', key: 'agent.model', value: 'gpt-4o' }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.previousResponseId).toBe(null);
});

it('replayEvents: v3 assistant_turn restores state without cumulative snapshot', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', model: 'gpt-5', provider: 'openai' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{"command":"pwd"}' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/repo' },
          { type: 'assistant_text', text: 'The current directory is /repo.' },
        ],
      },
      usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 },
      state: {
        previousResponseId: 'resp-v3',
        model: 'gpt-5',
        provider: 'openai',
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.previousResponseId).toBe('resp-v3');
  expect(restored.model).toBe('gpt-5');
  expect(restored.provider).toBe('openai');
  expect(restored.usage).toEqual({ prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
  expect(restored.history).toEqual([
    { role: 'user', type: 'message', content: 'run pwd' },
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
    { type: 'function_call_result', callId: 'call-1', name: 'shell', output: '/repo' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'The current directory is /repo.' }],
    },
  ]);
  expect(restored.toolLedger.length).toBe(1);
  expect(restored.toolLedger[0]).toMatchObject({
    callId: 'call-1',
    toolName: 'shell',
    arguments: '{"command":"pwd"}',
    status: 'completed',
    output: '/repo',
  });
  expect(restored.messages.length).toBe(3);
  expect(restored.messages[1].sender).toBe('command');
  expect(restored.messages[1].status).toBe('completed');
  expect(restored.messages[2].text).toBe('The current directory is /repo.');
  expect(restored.messages[2].usage).toBe(undefined);
});

it('replayEvents: timed-out partial assistant turn preserves tool history for the next message', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'continue the task' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: { command: 'pwd' } },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/repo' },
        ],
      },
      state: { previousResponseId: null },
    }),
    env({ type: 'error', message: 'network timed out', kind: 'network' }),
  ]);

  expect(restored.history).toEqual([
    { role: 'user', type: 'message', content: 'continue the task' },
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
    { type: 'function_call_result', callId: 'call-1', name: 'shell', output: '/repo' },
  ]);
  expect(restored.previousResponseId).toBe(null);
  expect(restored.replayWarnings.some((warning) => warning.includes('interrupted'))).toBe(false);
  expect(
    restored.messages.some((message) => message.sender === 'bot' && message.text === 'Error: network timed out'),
  ).toBe(true);
});

it('replayEvents: v3 assistant_turn preserves coarse tool_result ledger and avoids duplicates', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: '{"command":"pwd"}' }),
    env({ type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/repo' }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{"command":"pwd"}' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/repo' },
          { type: 'assistant_text', text: 'Done.' },
        ],
      },
      state: { previousResponseId: 'resp-v3' },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.toolLedger.length).toBe(1);
  expect(restored.toolLedger[0].callId).toBe('call-1');
  expect(restored.toolLedger[0].output).toBe('/repo');
  expect(restored.history.filter((item: any) => item.callId === 'call-1').length).toBe(2);
  expect(restored.replayWarnings.some((warning) => warning.includes('duplicated'))).toBe(false);
});

it('replayEvents: v3 assistant_turn compact state participates in cross-model invalidation', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', model: 'gpt-5' }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
      state: { previousResponseId: 'resp-v3', model: 'gpt-5' },
    }),
    env({ type: 'settings_changed', key: 'agent.model', value: 'gpt-4o' }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.previousResponseId).toBe(null);
});

it('replayEvents: trailing user_message inserts interrupted system message', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.messages.some((m) => m.sender === 'system' && String(m.text).includes('interrupted'))).toBe(true);
  expect(restored.replayWarnings.length > 0).toBe(true);
  expect(restored.previousResponseId).toBe(null);
});

it('replayEvents: interrupted turn nulls previousResponseId even when a prior turn completed', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', provider: 'openai' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'first' } }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'done' }] },
      state: { previousResponseId: 'resp-1', provider: 'openai' },
    }),
    env({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'second' } }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.replayWarnings.some((warning) => warning.includes('interrupted'))).toBe(true);
  expect(restored.previousResponseId).toBe(null);
});

it('replayEvents: tool_started followed by tool_result clears in-flight (no warning)', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    env({ type: 'tool_started', toolCallId: 'c1', toolName: 'shell', arguments: {} }),
    env({ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'ok' }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'c1', toolName: 'shell', arguments: {} },
          { type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'ok' },
          { type: 'assistant_text', text: 'done' },
        ],
      },
      state: { previousResponseId: 'r1' },
    }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.replayWarnings.length).toBe(0);
});

it('replayEvents: subagent_started + subagent_completed cleans up activity message and accumulates usage', () => {
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
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'all done' }] },
      state: { previousResponseId: 'r1' },
    }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.messages.some((m) => m.sender === 'subagent')).toBe(false);
  expect(restored.subagentUsage).toBeTruthy();
});

it('replayEvents: subagent_tool_started restores scoped activity without a parent in-flight tool', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'subagent_started', agentId: 'a1', role: 'worker', task: 'inspect' }),
    env({
      type: 'subagent_tool_started',
      agentId: 'a1',
      role: 'worker',
      toolCallId: 'nested-call-1',
      toolName: 'shell',
      arguments: { command: 'pwd' },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.toolLedger.length).toBe(0);
  expect(restored.messages.some((message: any) => message.sender === 'subagent' && message.agentId === 'a1')).toBe(
    true,
  );
});

it('replayEvents: unknown event type is ignored gracefully', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    { v: LOG_ENVELOPE_VERSION, seq: 99, ts: '', event: { type: 'made_up_event' } as any },
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
      state: { previousResponseId: 'r1' },
    }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.previousResponseId).toBe('r1');
});

it('replayEvents: truncated event is skipped and adds warning', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({
      type: 'assistant_turn',
      truncated: true,
      originalSize: 500000,
    } as any),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.replayWarnings.length).toBe(1);
  expect(restored.replayWarnings[0].includes('truncated')).toBe(true);
  expect(restored.history.length).toBe(0);
});

it('replayEvents: reconstructs history and ledger on mid-turn interruption', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run tool' } }),
    env({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'echo 1' } }),
    env({
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: '1\n',
      historyItems: [
        {
          role: 'assistant',
          type: 'message',
          content: '',
          tool_calls: [
            {
              type: 'function',
              id: 'call-1',
              function: { name: 'shell', arguments: '{"command":"echo 1"}' },
            },
          ],
        },
        {
          role: 'tool',
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: '1\n',
        },
      ],
    }),
  ];

  const restored = replayEvents(envelopes);

  // Replayed state should have:
  // 1. Reconstructed history containing user message and tool call/result items.
  // 2. Completed tool in the toolLedger.
  expect(restored.history.length).toBe(3); // user message, tool call, tool result
  expect((restored.history[0] as any).role).toBe('user');
  expect((restored.history[0] as any).content).toBe('run tool');
  expect((restored.history[1] as any).tool_calls[0].id).toBe('call-1');
  expect((restored.history[2] as any).callId).toBe('call-1');

  expect(restored.toolLedger.length).toBe(1);
  expect(restored.toolLedger[0].callId).toBe('call-1');
  expect(restored.toolLedger[0].status).toBe('completed');
  expect(restored.toolLedger[0].arguments).toEqual({ command: 'echo 1' });
});

it('replayEvents: handles incomplete in-flight tool call on interruption', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run tool' } }),
    env({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'echo 1' } }),
  ];

  const restored = replayEvents(envelopes);

  // The in-flight tool should be marked as aborted in the toolLedger.
  expect(restored.toolLedger.length).toBe(1);
  expect(restored.toolLedger[0].callId).toBe('call-1');
  expect(restored.toolLedger[0].status).toBe('aborted');
  expect(restored.toolLedger[0].failureReason).toBe('Session ended unexpectedly');

  // History should have the user message.
  expect(restored.history.length).toBe(1);
  expect((restored.history[0] as any).role).toBe('user');
  expect((restored.history[0] as any).content).toBe('run tool');
});

it('replayEvents: assistant_turn maps items to SavedMessage[] in correct order with stable call IDs', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'files' },
          { type: 'assistant_text', text: 'here is files' },
        ],
      },
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      snapshot: {
        history: [],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];

  const restored = replayEvents(envelopes);
  expect(restored.messages.length).toBe(4); // 1 user + 3 assistant_turn items (tool_result updates tool_call in-place)
  expect(restored.messages[0].sender).toBe('user');
  expect(restored.messages[1].sender).toBe('reasoning');
  expect(restored.messages[1].text).toBe('thinking');
  expect(restored.messages[1].status).toBe('finalized');
  expect(restored.messages[2].sender).toBe('command');
  expect(restored.messages[2].callId).toBe('call-1');
  expect(restored.messages[2].status).toBe('completed');
  expect(restored.messages[2].success).toBe(true);
  expect(restored.messages[2].output).toBe('files');
  expect(restored.messages[3].sender).toBe('bot');
  expect(restored.messages[3].text).toBe('here is files');
  expect(restored.messages[3].usage).toBe(undefined);
  expect(restored.usage).toEqual({ prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
});

it('replayEvents: assistant_turn renders apply_patch success output from parsed message field', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'patch it' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'apply_patch', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'apply_patch',
            status: 'completed',
            output: JSON.stringify({
              output: [{ success: true, operation: 'update_file', path: 'src/foo.ts', message: 'Updated src/foo.ts' }],
            }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command).toBeTruthy();
  expect(command?.output).toBe('Updated src/foo.ts');
});

it('replayEvents: assistant_turn renders apply_patch failure output from parsed error field', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'patch it' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'apply_patch', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'apply_patch',
            status: 'failed',
            output: JSON.stringify({
              output: [{ success: false, error: 'Invalid patch: context mismatch' }],
            }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command).toBeTruthy();
  expect(command?.output).toBe('Invalid patch: context mismatch');
  expect(command?.status).toBe('failed');
  expect(command?.success).toBe(false);
});

it('replayEvents: assistant_turn joins multi-item apply_patch results with newlines preserving order', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'patch both' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'apply_patch', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'apply_patch',
            status: 'completed',
            output: JSON.stringify({
              output: [
                { success: true, operation: 'update_file', path: 'a.ts', message: 'Updated a.ts' },
                { success: false, error: 'Invalid patch: bad context' },
              ],
            }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('Updated a.ts\nInvalid patch: bad context');
});

it('replayEvents: assistant_turn falls back to path when apply_patch item has no message and no error', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'patch it' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'apply_patch', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'apply_patch',
            status: 'completed',
            output: JSON.stringify({ output: [{ success: true, path: 'legacy.ts' }] }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('legacy.ts');
});

it('replayEvents: assistant_turn renders create_file success output from parsed message field', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'make file' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'create_file', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'create_file',
            status: 'completed',
            output: JSON.stringify({ success: true, path: 'new.ts', message: 'Created new.ts' }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('Created new.ts');
});

it('replayEvents: assistant_turn renders create_file failure output from parsed error field', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'make file' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'create_file', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'create_file',
            status: 'failed',
            output: JSON.stringify({ success: false, error: 'Error: File already exists at new.ts' }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('Error: File already exists at new.ts');
  expect(command?.status).toBe('failed');
});

it('replayEvents: assistant_turn falls through to JSON pretty-print for unknown tool output shape', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'weird tool' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: JSON.stringify({ unexpected: { nested: 1 } }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  // No error/message/path/summary keys; pretty-printed JSON is the contract.
  expect(command?.output as string).toMatch(/^\{\n  "unexpected": \{/);
});

it('replayEvents: assistant_turn unwraps AI-SDK style { type: text, text } wrapper from JSON string', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run something' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: JSON.stringify({ type: 'text', text: 'hello world' }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('hello world');
});

it('replayEvents: assistant_turn unwraps OpenAI Responses { type: output_text, text } wrapper from JSON string', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run something' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: JSON.stringify({ type: 'output_text', text: 'Tue May 12 18:40:41 +07 2026' }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('Tue May 12 18:40:41 +07 2026');
});

it('replayEvents: assistant_turn unwraps { content: [...] } content-parts array from JSON string', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run something' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: JSON.stringify({
              content: [
                { type: 'text', text: 'first' },
                { type: 'text', text: 'second' },
              ],
            }),
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('first\nsecond');
});

it('replayEvents: assistant_turn unwraps { type: text, text } wrapper when tool_result.output is already an object', () => {
  // Some tool results are persisted as raw objects (not JSON strings).
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run something' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: { type: 'text', text: 'plain output' } as unknown as string,
          },
        ],
      },
      snapshot: { history: [], previousResponseId: 'r1', toolLedger: [] },
    }),
  ];

  const restored = replayEvents(envelopes);
  const command = restored.messages.find((m) => m.sender === 'command' && m.callId === 'call-1');
  expect(command?.output).toBe('plain output');
});

it('replayEvents: assistant_turn prefers persisted displayUsage for resumed footer usage', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run ls' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'files' },
          { type: 'assistant_text', text: 'done' },
        ],
      },
      usage: { prompt_tokens: 6000, completion_tokens: 280, total_tokens: 6280 },
      displayUsage: { prompt_tokens: 3000, completion_tokens: 120, total_tokens: 3120 },
      snapshot: {
        history: [],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.messages[2].sender).toBe('bot');
  expect(restored.messages[2].usage).toEqual({ prompt_tokens: 3000, completion_tokens: 120, total_tokens: 3120 });
  expect(restored.usage).toEqual({ prompt_tokens: 6000, completion_tokens: 280, total_tokens: 6280 });
});

it('replayEvents: assistant_turn does not infer resumed footer usage from cumulative usage for tool turns', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run ls' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'files' },
          { type: 'assistant_text', text: 'done' },
        ],
      },
      usage: { prompt_tokens: 6000, completion_tokens: 280, total_tokens: 6280 },
      snapshot: {
        history: [],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.messages[2].sender).toBe('bot');
  expect(restored.messages[2].usage).toBe(undefined);
  expect(restored.usage).toEqual({ prompt_tokens: 6000, completion_tokens: 280, total_tokens: 6280 });
});

it('replayEvents: assistant_turn deduplicates earlier coarse command_message events from same turn', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } }),
    // Coarse events emitted during execution
    env({
      type: 'command_message',
      message: { id: 'cmd-coarse', sender: 'command', status: 'running', command: 'ls', output: '' },
    }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: 'ls' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'files' },
          { type: 'assistant_text', text: 'done' },
        ],
      },
      snapshot: {
        history: [],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];

  const restored = replayEvents(envelopes);
  // Coarse 'cmd-coarse' should be removed, replaced with replayed assistant turn messages.
  expect(restored.messages.length).toBe(3); // 1 user + 1 command + 1 bot
  expect(restored.messages[0].sender).toBe('user');
  expect(restored.messages[1].sender).toBe('command');
  expect(restored.messages[1].callId).toBe('call-1');
  expect(restored.messages[1].status).toBe('completed');
  expect(restored.messages[2].sender).toBe('bot');
  expect(restored.messages[2].text).toBe('done');
});

it('replayEvents: assistant_turn rebuilds structured assistant history for resume', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run date' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          {
            type: 'reasoning',
            text: 'I should run date.',
            providerMetadata: {
              reasoning_content: 'I should run date.',
              reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
            },
          },
          {
            type: 'tool_call',
            callId: 'call-1',
            toolName: 'shell',
            arguments: '{"command":"date"}',
            providerItem: {
              type: 'function_call',
              id: 'fc_1',
              callId: 'call-1',
              name: 'shell',
              arguments: '{"command":"date"}',
            },
          },
          {
            type: 'tool_result',
            callId: 'call-1',
            toolName: 'shell',
            status: 'completed',
            output: 'Mon Jan 01 00:00:00 UTC 2024',
            providerItem: {
              type: 'function_call_result',
              id: 'fr_1',
              callId: 'call-1',
              name: 'shell',
              output: 'Mon Jan 01 00:00:00 UTC 2024',
            },
          },
          {
            type: 'reasoning',
            text: 'Now answer.',
            providerMetadata: {
              reasoning_content: 'Now answer.',
            },
          },
          {
            type: 'assistant_text',
            text: 'Done.',
            providerMetadata: {
              reasoning_content: 'Now answer.',
            },
            providerItemId: 'msg_1',
          },
        ],
      },
      snapshot: {
        history: [],
        previousResponseId: 'r1',
        toolLedger: [],
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  // Reasoning is reconstructed as standalone history items (matching live SDK output)
  // rather than folded into the adjacent tool_call / assistant message providerData.
  // The reasoning text lives in the item's `content`; signature-bearing fields like
  // `reasoning_details` are preserved on the standalone item's providerData.
  expect(restored.history.length).toBe(6);
  expect(restored.history[0]).toEqual({ role: 'user', type: 'message', content: 'run date' });
  expect(restored.history[1]).toEqual({
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'I should run date.' }],
    rawContent: [{ type: 'reasoning_text', text: 'I should run date.' }],
    providerData: {
      reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
    },
  });
  expect(restored.history[2]).toEqual({
    type: 'function_call',
    id: 'fc_1',
    callId: 'call-1',
    name: 'shell',
    arguments: '{"command":"date"}',
  });
  expect(restored.history[3]).toEqual({
    type: 'function_call_result',
    id: 'fr_1',
    callId: 'call-1',
    name: 'shell',
    output: 'Mon Jan 01 00:00:00 UTC 2024',
  });
  expect(restored.history[4]).toEqual({
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'Now answer.' }],
    rawContent: [{ type: 'reasoning_text', text: 'Now answer.' }],
  });
  expect(restored.history[5]).toEqual({
    role: 'assistant',
    type: 'message',
    id: 'msg_1',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Done.' }],
  });
});

it('replayEvents: assistant_journal_delta restores partial assistant text on crash before final', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'tell me a story' } }),
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 1,
      kind: 'reasoning',
      delta: 'Let me think',
    }),
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 2,
      kind: 'text',
      delta: 'Once upon a time',
    }),
  ];

  const restored = replayEvents(envelopes);

  // Reasoning and assistant text fragments surface as visible messages.
  expect(restored.messages.some((m) => m.sender === 'reasoning' && m.text === 'Let me think')).toBe(true);
  expect(restored.messages.some((m) => m.sender === 'bot' && m.text === 'Once upon a time')).toBe(true);
  // History was reconstructed from the fragments so the next resumed request can see them.
  expect(restored.history.some((h: any) => h.type === 'reasoning' && h.content?.[0]?.text === 'Let me think')).toBe(
    true,
  );
  expect(restored.history.some((h: any) => h.role === 'assistant' && h.content?.[0]?.text === 'Once upon a time')).toBe(
    true,
  );
});

it('replayEvents: assistant_journal_item restores history and ledger on interrupted turn', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'reasoning',
        text: 'I should check the current directory.',
        providerMetadata: {
          reasoning_content: 'I should check the current directory.',
        },
      },
    }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 2,
      item: {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"pwd"}',
        providerItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      },
    }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 3,
      item: {
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
        output: '/repo',
        providerItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: '/repo',
        },
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  // Reasoning, tool call, and result were pushed into history for the next resumed request.
  const reasoningIndex = restored.history.findIndex((h: any) => h.type === 'reasoning');
  const callIndex = restored.history.findIndex((h: any) => h.type === 'function_call' && h.callId === 'call-1');
  const resultIndex = restored.history.findIndex(
    (h: any) => h.type === 'function_call_result' && h.callId === 'call-1',
  );
  expect(reasoningIndex > -1).toBe(true);
  expect(callIndex > reasoningIndex).toBe(true);
  expect(resultIndex > callIndex).toBe(true);
  expect((restored.history[reasoningIndex] as any).content[0].text).toBe('I should check the current directory.');
  expect((restored.history[callIndex] as any).name).toBe('shell');
  expect((restored.history[resultIndex] as any).output).toBe('/repo');
  expect((restored.toolLedger[0].historyItems?.[0] as any).type).toBe('reasoning');
  expect((restored.toolLedger[0].historyItems?.[1] as any).type).toBe('function_call');
  expect((restored.toolLedger[0].historyItems?.[2] as any).type).toBe('function_call_result');
  // The corresponding command message in the UI shows the completed output.
  const commandMsg = restored.messages.find((m: any) => m.sender === 'command' && m.callId === 'call-1');
  expect(commandMsg).toBeTruthy();
  expect(commandMsg?.status).toBe('completed');
  expect(commandMsg?.output).toBe('/repo');
});

it('replayEvents: journal reasoning is preserved when tool_result already populated ledger history', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'reasoning',
        text: 'I should check pwd.',
        providerMetadata: { reasoning_content: 'I should check pwd.' },
      },
    }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 2,
      item: {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"pwd"}',
        providerItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      },
    }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 3,
      item: {
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
        output: '/repo',
        providerItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: '/repo',
        },
      },
    }),
    env({
      type: 'tool_result',
      turnId: 'turn-1',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: '/repo',
      historyItems: [
        { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
        { type: 'function_call_result', callId: 'call-1', name: 'shell', output: '/repo' },
      ],
    }),
  ];

  const restored = replayEvents(envelopes);
  const historyItems = restored.toolLedger[0].historyItems as Array<Record<string, unknown>>;

  expect(historyItems.map((item) => item.type)).toEqual(['reasoning', 'function_call', 'function_call_result']);
  expect((historyItems[0].content as any[])[0].text).toBe('I should check pwd.');
});

it('replayEvents: mixed journal items and fragments preserve partial assistant output', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"pwd"}',
        providerItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      },
    }),
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 2,
      kind: 'reasoning',
      delta: 'checking the workspace',
    }),
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 3,
      kind: 'text',
      delta: 'I found the file',
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.messages.some((m: any) => m.sender === 'command' && m.callId === 'call-1')).toBe(true);
  expect(restored.messages.some((m: any) => m.sender === 'reasoning' && m.text === 'checking the workspace')).toBe(
    true,
  );
  expect(restored.messages.some((m: any) => m.sender === 'bot' && m.text === 'I found the file')).toBe(true);
  expect(
    restored.history.some((h: any) => h.type === 'reasoning' && h.content?.[0]?.text === 'checking the workspace'),
  ).toBe(true);
  expect(restored.history.some((h: any) => h.role === 'assistant' && h.content?.[0]?.text === 'I found the file')).toBe(
    true,
  );
});

it('replayEvents: approval_required without final turn restores open tool state', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'rm -rf /' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: '{"command":"rm -rf /"}',
        providerItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"rm -rf /"}',
        },
      },
    }),
    env({
      type: 'approval_required',
      approval: { callId: 'call-1', toolName: 'shell', argumentsText: 'rm -rf /', agentName: 'assistant' },
    }),
  ];

  const restored = replayEvents(envelopes);

  // Approval is still pending -> the in-flight tool call must remain
  // visible in the recovery state (toolLedger carries the started entry)
  // instead of being marked aborted.
  expect(restored.toolLedger.length > 0).toBe(true);
  expect(restored.history.some((h: any) => h.type === 'function_call' && h.callId === 'call-1')).toBe(true);
  expect(restored.previousResponseId).toBe(null);
});

it('replayEvents: completed turn prefers assistant_turn over earlier journal fragments', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'do it' } }),
    // Coarse journal fragments: an older draft the model streamed and replaced.
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 1,
      kind: 'text',
      delta: 'draft ',
    }),
    env({
      type: 'assistant_journal_delta',
      turnId: 'turn-1',
      seq: 2,
      kind: 'text',
      delta: 'text',
    }),
    // Final assistant_turn supersedes the journal transcript.
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'final' }] },
      state: { previousResponseId: 'r1' },
    }),
  ];

  const restored = replayEvents(envelopes);

  // The draft "draft text" must NOT appear in messages or history; only "final" should.
  expect(restored.messages.some((m: any) => m.sender === 'bot' && m.text === 'draft text')).toBe(false);
  expect(restored.messages.some((m: any) => m.sender === 'bot' && m.text === 'final')).toBe(true);
  expect(restored.history.some((h: any) => h.role === 'assistant' && h.content?.[0]?.text === 'draft text')).toBe(
    false,
  );
});

it('replayEvents: command_message tool output is deduped when a richer tool result exists', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    // Coarse command_message emitted during streaming: "running" placeholder.
    env({
      type: 'command_message',
      message: {
        id: 'cmd-1',
        sender: 'command',
        status: 'running',
        command: 'pwd',
        output: '',
        callId: 'call-1',
        toolName: 'shell',
      },
    }),
    // Journal tool_result with the real, richer output.
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'shell',
        status: 'completed',
        output: '/repo',
        providerItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: '/repo',
        },
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  // The journal's richer tool result wins; the running placeholder is gone.
  const commandMsgs = restored.messages.filter((m: any) => m.sender === 'command' && m.callId === 'call-1');
  expect(commandMsgs.length).toBe(1);
  expect(commandMsgs[0].status).toBe('completed');
  expect(commandMsgs[0].output).toBe('/repo');
});
