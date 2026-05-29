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

test('replayEvents: unsupported assistant_final is ignored', (t) => {
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
  t.is(restored.history.length, 0);
  t.is(restored.previousResponseId, null);
  t.is(restored.messages.length, 0);
});

test('replayEvents: cross-model invalidation nulls previousResponseId', (t) => {
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
  t.is(restored.previousResponseId, null);
});

test('replayEvents: v3 assistant_turn restores state without cumulative snapshot', (t) => {
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

  t.is(restored.previousResponseId, 'resp-v3');
  t.is(restored.model, 'gpt-5');
  t.is(restored.provider, 'openai');
  t.deepEqual(restored.usage, { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
  t.deepEqual(restored.history, [
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
  t.is(restored.toolLedger.length, 1);
  t.like(restored.toolLedger[0], {
    callId: 'call-1',
    toolName: 'shell',
    arguments: '{"command":"pwd"}',
    status: 'completed',
    output: '/repo',
  });
  t.is(restored.messages.length, 3);
  t.is(restored.messages[1].sender, 'command');
  t.is(restored.messages[1].status, 'completed');
  t.is(restored.messages[2].text, 'The current directory is /repo.');
});

test('replayEvents: v3 assistant_turn preserves coarse tool_result ledger and avoids duplicates', (t) => {
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

  t.is(restored.toolLedger.length, 1);
  t.is(restored.toolLedger[0].callId, 'call-1');
  t.is(restored.toolLedger[0].output, '/repo');
  t.is(restored.history.filter((item: any) => item.callId === 'call-1').length, 2);
  t.false(restored.replayWarnings.some((warning) => warning.includes('duplicated')));
});

test('replayEvents: v3 assistant_turn compact state participates in cross-model invalidation', (t) => {
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
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'all done' }] },
      state: { previousResponseId: 'r1' },
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
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'ok' }] },
      state: { previousResponseId: 'r1' },
    }),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.previousResponseId, 'r1');
});

test('replayEvents: truncated event is skipped and adds warning', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({
      type: 'assistant_turn',
      truncated: true,
      originalSize: 500000,
    } as any),
  ];
  const restored = replayEvents(envelopes);
  t.is(restored.replayWarnings.length, 1);
  t.true(restored.replayWarnings[0].includes('truncated'));
  t.is(restored.history.length, 0);
});

test('replayEvents: reconstructs history and ledger on mid-turn interruption', (t) => {
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
  t.is(restored.history.length, 3); // user message, tool call, tool result
  t.is((restored.history[0] as any).role, 'user');
  t.is((restored.history[0] as any).content, 'run tool');
  t.is((restored.history[1] as any).tool_calls[0].id, 'call-1');
  t.is((restored.history[2] as any).callId, 'call-1');

  t.is(restored.toolLedger.length, 1);
  t.is(restored.toolLedger[0].callId, 'call-1');
  t.is(restored.toolLedger[0].status, 'completed');
  t.deepEqual(restored.toolLedger[0].arguments, { command: 'echo 1' });
});

test('replayEvents: handles incomplete in-flight tool call on interruption', (t) => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run tool' } }),
    env({ type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'echo 1' } }),
  ];

  const restored = replayEvents(envelopes);

  // The in-flight tool should be marked as aborted in the toolLedger.
  t.is(restored.toolLedger.length, 1);
  t.is(restored.toolLedger[0].callId, 'call-1');
  t.is(restored.toolLedger[0].status, 'aborted');
  t.is(restored.toolLedger[0].failureReason, 'Session ended unexpectedly');

  // History should have the user message.
  t.is(restored.history.length, 1);
  t.is((restored.history[0] as any).role, 'user');
  t.is((restored.history[0] as any).content, 'run tool');
});

test('replayEvents: assistant_turn maps items to SavedMessage[] in correct order with stable call IDs', (t) => {
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
  t.is(restored.messages.length, 4); // 1 user + 3 assistant_turn items (tool_result updates tool_call in-place)
  t.is(restored.messages[0].sender, 'user');
  t.is(restored.messages[1].sender, 'reasoning');
  t.is(restored.messages[1].text, 'thinking');
  t.is(restored.messages[2].sender, 'command');
  t.is(restored.messages[2].callId, 'call-1');
  t.is(restored.messages[2].status, 'completed');
  t.is(restored.messages[2].success, true);
  t.is(restored.messages[2].output, 'files');
  t.is(restored.messages[3].sender, 'bot');
  t.is(restored.messages[3].text, 'here is files');
  t.deepEqual(restored.usage, { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
});

test('replayEvents: assistant_turn deduplicates earlier coarse command_message events from same turn', (t) => {
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
  t.is(restored.messages.length, 3); // 1 user + 1 command + 1 bot
  t.is(restored.messages[0].sender, 'user');
  t.is(restored.messages[1].sender, 'command');
  t.is(restored.messages[1].callId, 'call-1');
  t.is(restored.messages[1].status, 'completed');
  t.is(restored.messages[2].sender, 'bot');
  t.is(restored.messages[2].text, 'done');
});

test('replayEvents: assistant_turn rebuilds structured assistant history for resume', (t) => {
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
  t.is(restored.history.length, 6);
  t.deepEqual(restored.history[0], { role: 'user', type: 'message', content: 'run date' });
  t.deepEqual(restored.history[1], {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'I should run date.' }],
    rawContent: [{ type: 'reasoning_text', text: 'I should run date.' }],
    providerData: {
      reasoning_details: [{ type: 'summary_text', text: 'I should run date.' }],
    },
  });
  t.deepEqual(restored.history[2], {
    type: 'function_call',
    id: 'fc_1',
    callId: 'call-1',
    name: 'shell',
    arguments: '{"command":"date"}',
  });
  t.deepEqual(restored.history[3], {
    type: 'function_call_result',
    id: 'fr_1',
    callId: 'call-1',
    name: 'shell',
    output: 'Mon Jan 01 00:00:00 UTC 2024',
  });
  t.deepEqual(restored.history[4], {
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'Now answer.' }],
    rawContent: [{ type: 'reasoning_text', text: 'Now answer.' }],
  });
  t.deepEqual(restored.history[5], {
    role: 'assistant',
    type: 'message',
    id: 'msg_1',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Done.' }],
  });
});
