import { it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LOG_ENVELOPE_VERSION, type LogEnvelope, type LogEvent } from '../logging/conversation-log-events.js';
import { replayEvents } from './conversation-replay.js';
import { projectSemanticEvents } from './semantic-replay-projection.js';
import { decodeLogEnvelope, decodeSavedMessage, resolveEnvelopeIdentities } from './conversation-decoder.js';
import type { BotMessage, CommandMessage, ReasoningMessage } from '../../types/message.js';
import { normalizeApplicationInput } from '../agent-runtime/application-run-loop.js';
import { profileIdFromLegacyMode } from '../profiles/legacy-adapter.js';
import { ConversationStore } from './conversation-store.js';
import { planLocalCompaction } from '../agent-runtime/context-compaction/index.js';
import { createCheckpointSourceDigest, resolveCheckpointSourceRefs } from './conversation-checkpoint-provenance.js';
import { deriveLocalCheckpointRequestHistory } from './local-checkpoint-projection.js';

let seq = 0;
function env(event: LogEvent): LogEnvelope {
  return { v: LOG_ENVELOPE_VERSION, seq: ++seq, ts: new Date().toISOString(), event };
}

beforeEach(() => {
  seq = 0;
});

const loadFixture = (name: string): LogEnvelope[] => {
  const filePath = path.join(process.cwd(), 'source/services/conversation/__fixtures__', name);
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LogEnvelope);
};

it('replayEvents: empty log produces empty state with no warnings', () => {
  const restored = replayEvents([]);
  expect(restored.id).toBe('');
  expect(restored.history.length).toBe(0);
  expect(restored.messages.length).toBe(0);
  expect(restored.replayWarnings).toEqual([]);
  expect(restored.goal).toBeUndefined();
});

it('decodes only bounded versioned goal records and replays the latest valid event', () => {
  const active = {
    type: 'goal_changed',
    version: 1,
    goal: { id: 'g1', outcome: 'Ship it', status: 'active' },
  } as const;
  const achieved = {
    type: 'goal_changed',
    version: 1,
    goal: { id: 'g1', outcome: 'Ship it', successCriteria: 'Tests pass', status: 'achieved' },
  } as const;
  expect(decodeLogEnvelope(env(active))).not.toBeNull();
  expect(decodeLogEnvelope({ ...env(active), event: { ...active, version: 2 } })).toBeNull();
  expect(
    decodeLogEnvelope({ ...env(active), event: { ...active, goal: { ...active.goal, outcome: 'x'.repeat(2001) } } }),
  ).toBeNull();
  expect(replayEvents([env(active), env(achieved)]).goal).toEqual(achieved.goal);
});

it('ignores malformed goal events without affecting other replay state', () => {
  const valid = env({ type: 'goal_changed', version: 1, goal: { id: 'g1', outcome: 'Keep', status: 'active' } });
  const malformed = {
    ...env({ type: 'session_cleared' }),
    event: { type: 'goal_changed', version: 99 },
  } as unknown as LogEnvelope;
  expect(decodeLogEnvelope(malformed)).toBeNull();
  const decoded = [valid, malformed].map((envelope) => decodeLogEnvelope(envelope)).filter((item) => item !== null);
  expect(replayEvents(decoded).goal).toEqual(valid.event.type === 'goal_changed' ? valid.event.goal : undefined);
});

it.each(['openai', 'local'] as const)(
  'replayEvents restores %s compacted provider history and appends later turns to the replacement',
  (kind) => {
    const history =
      kind === 'openai'
        ? [
            {
              type: 'compaction',
              id: 'checkpoint-native',
              encrypted_content: 'opaque',
              providerOpaque: { provider: 'openai' },
            },
          ]
        : [
            { role: 'user' as const, type: 'message' as const, content: 'earlier user turn' },
            {
              role: 'system' as const,
              type: 'message' as const,
              content: 'local summary',
              contextSummary: { version: 1 as const, strategy: 'local' as const },
            },
            { role: 'user' as const, type: 'message' as const, content: 'hot user turn' },
          ];
    const coldCall: any = {
      type: 'function_call',
      callId: 'call-cold',
      name: 'cold',
      arguments: '{"secret":"COLD TOOL PAYLOAD"}',
    };
    const coldResult: any = {
      type: 'function_call_result',
      callId: 'call-cold',
      name: 'cold',
      output: 'COLD TOOL PAYLOAD',
    };
    const hotCall: any = { type: 'function_call', callId: 'call-hot', name: 'hot', arguments: '{}' };
    const hotResult: any = { type: 'function_call_result', callId: 'call-hot', name: 'hot', output: 'ok' };
    const firstTurn = env({
      type: 'assistant_turn',
      turn: {
        items: [{ type: 'assistant_text', text: 'DISTINCTIVE PRE-COMPACTION ASSISTANT PHRASE' }, coldCall, coldResult],
      },
      state: { previousResponseId: 'prior-response' },
    });
    const compactedTurn = env({
      type: 'assistant_turn',
      turn: {
        items: [coldCall, coldResult, hotCall, hotResult, { type: 'assistant_text', text: 'post-compaction output' }],
      },
      providerHistory: [
        ...history,
        hotCall,
        hotResult,
        { role: 'assistant', type: 'message', content: 'post-compaction output' },
      ],
      state: { previousResponseId: 'after-compaction' },
    });
    const providerHistory = (compactedTurn.event as Extract<LogEvent, { type: 'assistant_turn' }>).providerHistory!;
    const laterUser = env({
      type: 'user_message',
      message: { id: 'user-3', sender: 'user', text: 'later turn', timestamp: 't3' } as any,
    });
    const laterAnswer = env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'later answer' }] },
      state: { previousResponseId: 'later-response' },
    });
    const restored = replayEvents([
      env({ type: 'session_init', id: 'compacted-session', createdAt: '2026-09-26T00:00:00Z' }),
      env({
        type: 'user_message',
        message: { id: 'user-1', sender: 'user', text: 'earlier user turn', timestamp: 't1' } as any,
      }),
      firstTurn,
      env({
        type: 'user_message',
        message: { id: 'user-2', sender: 'user', text: 'current user turn', timestamp: 't2' } as any,
      }),
      compactedTurn,
      laterUser,
      laterAnswer,
    ]);

    expect(JSON.stringify(restored.history)).not.toContain('DISTINCTIVE PRE-COMPACTION ASSISTANT PHRASE');
    expect(JSON.stringify(restored.history)).not.toContain('COLD TOOL PAYLOAD');
    expect(restored.history.slice(0, providerHistory.length)).toEqual(providerHistory);
    expect(JSON.stringify(restored.history.slice(providerHistory.length))).toContain('later turn');
    expect(JSON.stringify(restored.history.slice(providerHistory.length))).toContain('later answer');
    expect(restored.history.filter((item: any) => item.callId === 'call-hot')).toHaveLength(2);
    const store = new ConversationStore();
    store.replaceHistory(restored.history);
    expect(store.getProviderHistorySnapshot().history).toEqual(restored.history);
  },
);

it('replays a memory receipt from the persisted event without adding it to provider history', () => {
  const record = env({
    type: 'memory_injected',
    turnId: 'turn-1',
    memories: [{ scope: 'global', id: 'rule', title: 'Rule' }],
  });
  expect(decodeLogEnvelope(record)).toBeDefined();
  const restored = replayEvents([record]);
  expect(restored.messages).toMatchObject([
    { sender: 'system', text: 'Loaded 1 memory: global / rule — Rule', memoryReceiptCount: 1 },
  ]);
  expect(restored.history).toEqual([]);
});

it('replayEvents: session_init populates session metadata', () => {
  const envelopes: LogEnvelope[] = [
    env({
      type: 'session_init',
      id: 'sess-1',
      createdAt: '2026-01-01T00:00:00Z',
      projectPath: '/p',
      sshHost: 'h',
      activeProfileId: 'builtin:plan',
      model: 'gpt-5',
      provider: 'openai',
      reasoningEffort: 'high',
    }),
  ];
  const restored = replayEvents(envelopes);
  expect(restored.id).toBe('sess-1');
  expect(restored.projectPath).toBe('/p');
  expect(restored.sshHost).toBe('h');
  expect(restored.activeProfileId).toBe('builtin:plan');
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

it('replayEvents: canonical profile setting changes update the restored profile', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', activeProfileId: 'builtin:standard' }),
    env({ type: 'settings_changed', key: 'app.activeProfileId', value: 'builtin:mentor' }),
  ]);

  expect(restored.activeProfileId).toBe('builtin:mentor');
});

it('replayEvents: legacy profile setting changes update canonical profile state', () => {
  const restored = replayEvents([
    env({
      type: 'session_init',
      id: 'legacy-session',
      createdAt: '2026-01-01T00:00:00Z',
      appMode: { mentorMode: false, liteMode: false, planMode: true, orchestratorMode: false },
    }),
    env({ type: 'settings_changed', key: 'app.liteMode', value: true }),
    env({ type: 'settings_changed', key: 'app.liteMode', value: false }),
  ]);

  expect(restored.activeProfileId).toBe('builtin:standard');
  expect(restored.appMode).toEqual({
    mentorMode: false,
    liteMode: false,
    planMode: false,
    orchestratorMode: false,
  });
});

it('replayEvents: legacy-only session state remains resumable through precedence migration', () => {
  const restored = replayEvents([
    env({
      type: 'session_init',
      id: 'legacy-session',
      createdAt: '2026-01-01T00:00:00Z',
      appMode: { mentorMode: true, liteMode: true, planMode: true, orchestratorMode: true },
    }),
  ]);

  expect(restored.activeProfileId).toBeUndefined();
  expect(profileIdFromLegacyMode(restored.appMode)).toBe('builtin:orchestrator');
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
  expect((restored.messages[1] as CommandMessage).status).toBe('completed');
  expect((restored.messages[2] as BotMessage).text).toBe('The current directory is /repo.');
  expect((restored.messages[2] as BotMessage).usage).toBe(undefined);
});

it('replayEvents: golden legacy v2 conversation restores from snapshot format', () => {
  const restored = replayEvents(loadFixture('legacy-v2-conversation.jsonl'));

  expect(restored.id).toBe('legacy-v2');
  expect(restored.previousResponseId).toBe('resp-v2');
  expect(restored.history.map((item: any) => item.callId).filter(Boolean)).toEqual(['call-1', 'call-1']);
  expect(restored.toolLedger).toHaveLength(1);
  expect(restored.messages.map((message) => message.sender)).toEqual(['user', 'command', 'bot']);
});

it('replayEvents: golden current v3 conversation restores from compact assistant state', () => {
  const restored = replayEvents(loadFixture('current-v3-conversation.jsonl'));

  expect(restored.id).toBe('current-v3');
  expect(restored.previousResponseId).toBe('resp-v3');
  expect(restored.history.map((item: any) => item.callId).filter(Boolean)).toEqual(['call-1', 'call-1']);
  expect(restored.toolLedger).toHaveLength(1);
  expect(restored.messages.map((message) => message.sender)).toEqual(['user', 'command', 'bot']);
});

it('replayEvents: preserves dispatched-but-unknown tool outcomes', () => {
  const toolStarted = env({
    type: 'tool_started',
    turnId: 'turn-1',
    toolCallId: 'call-unknown',
    toolName: 'shell',
    arguments: { command: 'write' },
  });
  const toolResult = env({
    type: 'tool_result',
    turnId: 'turn-1',
    callId: 'call-unknown',
    toolName: 'shell',
    status: 'unknown',
    output: 'Verify before retrying.',
  });
  expect(decodeLogEnvelope(toolResult)).not.toBeNull();
  const restored = replayEvents([toolStarted, toolResult]);

  expect(restored.toolLedger).toMatchObject([
    { callId: 'call-unknown', status: 'unknown', output: 'Verify before retrying.' },
  ]);
});

it('decodeLogEnvelope: accepts an unknown status in a persisted assistant turn item', () => {
  const envelope = env({
    type: 'assistant_turn',
    turn: {
      items: [
        {
          type: 'tool_result',
          callId: 'call-unknown',
          toolName: 'shell',
          status: 'unknown',
          output: 'Verify before retrying.',
        },
      ],
    },
  });
  const decoded = decodeLogEnvelope(envelope);

  expect(decoded).not.toBeNull();
  expect(replayEvents([decoded!]).toolLedger).toMatchObject([{ callId: 'call-unknown', status: 'unknown' }]);
  expect(replayEvents([decoded!]).messages).toMatchObject([{ sender: 'command', status: 'unknown' }]);
});

it('semantic projection reconstructs interrupted output and approvals without resuming them', () => {
  const result = projectSemanticEvents([
    env({ type: 'session_init', id: 'semantic-interrupted', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'continue safely' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 't1',
      seq: 1,
      item: { type: 'assistant_text', text: 'Partial answer' },
    }),
    env({
      type: 'approval_required',
      turnId: 't1',
      approval: { callId: 'c1', toolName: 'shell', argumentsText: '{"command":"write"}' },
    }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status !== 'projected') return;
  expect(
    result.state.messages.some((message) => message.sender === 'bot' && message.text.includes('Partial answer')),
  ).toBe(true);
  expect(
    result.state.messages.some((message) => message.sender === 'system' && message.text.includes('interrupted')),
  ).toBe(true);
  expect(result.state.previousResponseId).toBeNull();
  expect(result.state.messages.some((message) => message.sender === 'command' && message.status === 'running')).toBe(
    false,
  );
});

it('semantic projection derives parallel complete and partial tool ledger entries from turn items', () => {
  const result = projectSemanticEvents([
    env({ type: 'session_init', id: 'semantic-parallel', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run both' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'c1', toolName: 'shell', arguments: { command: 'a' } },
          { type: 'tool_call', callId: 'c2', toolName: 'shell', arguments: { command: 'b' } },
          { type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'a' },
        ],
      },
    }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status !== 'projected') return;
  expect(result.state.toolLedger).toMatchObject([
    { callId: 'c1', status: 'completed', output: 'a' },
    { callId: 'c2', status: 'started' },
  ]);
});

it('semantic projection preserves complete parallel tool call/result batches', () => {
  const result = projectSemanticEvents([
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run both' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'c1', toolName: 'shell', arguments: 'a' },
          { type: 'tool_call', callId: 'c2', toolName: 'shell', arguments: 'b' },
          { type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'a' },
          { type: 'tool_result', callId: 'c2', toolName: 'shell', status: 'completed', output: 'b' },
        ],
      },
    }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status === 'projected') {
    expect(result.state.toolLedger).toMatchObject([
      { callId: 'c1', status: 'completed', output: 'a' },
      { callId: 'c2', status: 'completed', output: 'b' },
    ]);
  }
});

it('semantic projection preserves unknown tool effects instead of treating them as completed', () => {
  const result = projectSemanticEvents([
    env({ type: 'tool_started', turnId: 't1', toolCallId: 'c-unknown', toolName: 'shell', arguments: 'write' }),
    env({
      type: 'tool_result',
      turnId: 't1',
      callId: 'c-unknown',
      toolName: 'shell',
      status: 'unknown',
      output: 'Verify before retrying.',
    }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status === 'projected') {
    expect(result.state.toolLedger).toMatchObject([{ callId: 'c-unknown', status: 'unknown' }]);
  }
});

it('semantic projection strips provider chain anchors but follows provider/model settings', () => {
  const result = projectSemanticEvents([
    env({
      type: 'session_init',
      id: 'semantic-switch',
      createdAt: '2026-01-01T00:00:00Z',
      model: 'model-a',
      provider: 'provider-a',
    }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'done' }] },
      state: { previousResponseId: 'ephemeral-chain', model: 'model-a', provider: 'provider-a' },
    }),
    env({ type: 'settings_changed', key: 'agent.model', value: 'model-b' }),
    env({ type: 'settings_changed', key: 'agent.provider', value: 'provider-b' }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status !== 'projected') return;
  expect(result.state.model).toBe('model-b');
  expect(result.state.provider).toBe('provider-b');
  expect(result.state.previousResponseId).toBeNull();
});

it('semantic projection excludes provider-opaque state from canonical history', () => {
  const result = projectSemanticEvents([
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'portable prompt' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'provider_opaque', provider: 'vendor-a', item: { token: 'opaque' } },
          { type: 'assistant_text', text: 'portable response' },
        ],
      },
    }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status === 'projected') {
    expect(result.state.history).toEqual([
      { role: 'user', type: 'message', content: 'portable prompt' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'portable response' }],
      },
    ]);
  }
});

it('semantic projection reports snapshot-only undo as unsupported', () => {
  const undo = env({
    type: 'undo',
    removedUserTurns: 1,
    snapshot: { history: [], previousResponseId: null, toolLedger: [] },
  });
  expect(projectSemanticEvents([undo])).toEqual({
    status: 'unsupported',
    reason: 'legacy_undo_snapshot',
    seq: undo.seq,
  });
});

it('semantic projection retracts exactly the referenced source events and invalidates chain anchors', () => {
  const init = {
    ...env({ type: 'session_init', id: 'retract', createdAt: '2026-01-01T00:00:00Z' }),
    logId: 'retract',
    eventId: 'e-init',
  };
  const user = {
    ...env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'remove me' } }),
    logId: 'retract',
    eventId: 'e-user',
  };
  const turn = {
    ...env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'c1', toolName: 'shell', arguments: 'write' },
          { type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'completed', output: 'done' },
          { type: 'assistant_text', text: 'remove result' },
        ],
      },
      state: { previousResponseId: 'chain-secret', model: 'model-a', provider: 'provider-a' },
    }),
    logId: 'retract',
    eventId: 'e-turn',
  };
  const retraction = {
    ...env({
      type: 'events_retracted',
      version: 1,
      refs: [
        { logId: 'retract', eventId: 'e-user' },
        { logId: 'retract', eventId: 'e-turn' },
      ],
    }),
    logId: 'retract',
    eventId: 'e-retraction',
  };

  const actual = projectSemanticEvents([init, user, turn, retraction]);
  const expected = projectSemanticEvents([init]);
  expect(actual).toEqual(expected);
  expect(user.event.type).toBe('user_message');
  expect(turn.event.type).toBe('assistant_turn');
  expect(retraction.event.type).toBe('events_retracted');
});

it('semantic projection refuses unresolved retraction refs instead of consulting a legacy snapshot', () => {
  const snapshotTurn = {
    ...env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'snapshot must not restore me' }] },
      snapshot: {
        history: [{ role: 'assistant', type: 'message', content: 'not a source' }],
        previousResponseId: 'r',
        toolLedger: [],
      },
    }),
    logId: 'local',
    eventId: 'e-turn',
  };
  const retract = {
    ...env({ type: 'events_retracted', version: 1, refs: [{ logId: 'predecessor', eventId: 'missing' }] }),
    logId: 'local',
    eventId: 'e-retract',
  };

  expect(projectSemanticEvents([snapshotTurn, retract])).toEqual({
    status: 'unsupported',
    reason: 'unresolved_retraction_refs',
    seq: retract.seq,
  });
});

it('semantic projection applies child-local retractions without changing parent projection', () => {
  const inherited = {
    ...env({ type: 'user_message', message: { id: 'u-parent', sender: 'user', text: 'parent turn' } }),
    logId: 'parent',
    eventId: 'parent-event',
  };
  const parentBefore = projectSemanticEvents([inherited]);
  const childRetraction = {
    ...env({ type: 'events_retracted', version: 1, refs: [{ logId: 'parent', eventId: 'parent-event' }] }),
    logId: 'child',
    eventId: 'child-retract',
  };
  const child = projectSemanticEvents([inherited, childRetraction]);
  const parentAfter = projectSemanticEvents([inherited]);

  expect(parentAfter).toEqual(parentBefore);
  expect(child).toMatchObject({ status: 'projected', state: { messages: [] } });
});

it('semantic projection cannot retract a rollover predecessor that is outside the new log', () => {
  const newSession = {
    ...env({ type: 'session_init', id: 'successor', createdAt: '2026-01-01T00:00:00Z', rolloverFrom: 'predecessor' }),
    logId: 'successor',
    eventId: 'successor-init',
  };
  const retract = {
    ...env({ type: 'events_retracted', version: 1, refs: [{ logId: 'predecessor', eventId: 'old-user' }] }),
    logId: 'successor',
    eventId: 'successor-retract',
  };

  expect(projectSemanticEvents([newSession, retract])).toMatchObject({
    status: 'unsupported',
    reason: 'unresolved_retraction_refs',
  });
});

it('semantic projection does not apply a checkpoint that covers a retracted source', () => {
  const source = {
    ...env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'source' } }),
    logId: 's',
    eventId: 'e-source',
  };
  const checkpoint = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'summary-1',
      sourceRefs: [{ logId: 's', eventId: 'e-source' }],
      item: { role: 'system', type: 'message', content: 'summary should not apply' },
    }),
    logId: 's',
    eventId: 'e-checkpoint',
  };
  const retract = {
    ...env({ type: 'events_retracted', version: 1, refs: [{ logId: 's', eventId: 'e-source' }] }),
    logId: 's',
    eventId: 'e-retract',
  };
  const valid = projectSemanticEvents([source, checkpoint]);
  const retracted = projectSemanticEvents([source, checkpoint, retract]);

  expect(valid).toMatchObject({
    status: 'projected',
    state: { history: [{ role: 'user', content: 'source' }, { content: 'summary should not apply' }] },
  });
  expect(retracted).toMatchObject({ status: 'projected', state: { history: [] } });
});

it('semantic projection does not apply a checkpoint whose source ref is missing', () => {
  const source = {
    ...env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'source' } }),
    logId: 's',
    eventId: 'e-source',
  };
  const checkpoint = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'summary-missing-source',
      sourceRefs: [{ logId: 's', eventId: 'does-not-exist' }],
      item: { role: 'system', type: 'message', content: 'must not apply' },
    }),
    logId: 's',
    eventId: 'e-checkpoint',
  };

  expect(projectSemanticEvents([source, checkpoint])).toMatchObject({
    status: 'projected',
    state: { history: [{ role: 'user', content: 'source' }] },
  });
});

it('semantic projection refuses a checkpoint whose source payload no longer matches its digest', () => {
  const source = {
    ...env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'original' } }),
    logId: 's',
    eventId: 'e-source',
  };
  const refs = [{ logId: 's', eventId: 'e-source' }];
  const digest = createCheckpointSourceDigest(refs, [source])!;
  const changedSource = {
    ...source,
    event: { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'mutated' } },
  } as typeof source;
  const checkpoint = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'digest-check',
      sourceRefs: refs,
      sourceDigest: digest,
      item: { role: 'system', type: 'message', content: 'unverified' },
    } as const),
    logId: 's',
    eventId: 'e-checkpoint',
  };
  expect(projectSemanticEvents([changedSource, checkpoint])).toEqual({
    status: 'unsupported',
    reason: 'unverifiable_checkpoint',
    seq: checkpoint.seq,
  });
});

it('replay derives a provenance-proven local checkpoint request from the checkpoint and uncovered source events', () => {
  const checkpoint = {
    role: 'assistant',
    type: 'message',
    content: [{ type: 'output_text', text: 'durable summary' }],
    contextSummary: { version: 1 as const, strategy: 'local' as const },
  };
  const hotUser = { role: 'user', type: 'message', content: 'hot question' };
  const hotAssistant = {
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hot answer' }],
  };
  const secondHotUser = { role: 'user', type: 'message', content: 'hot question two' };
  const secondHotAssistant = {
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hot answer two' }],
  };
  const nextUser = { role: 'user', type: 'message', content: 'next question' };
  const nextAssistant = {
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'next answer' }],
  };
  const sourceUser = {
    ...env({ type: 'user_message', message: { id: 'cold-u', sender: 'user', text: 'cold question' } }),
    logId: 's',
    eventId: 'cold-user',
  };
  const sourceAssistant = {
    ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'cold answer' }] } }),
    logId: 's',
    eventId: 'cold-assistant',
  };
  const hotUsersAndAssistantEvents = [
    {
      ...env({ type: 'user_message', message: { id: 'hot-u1', sender: 'user', text: 'hot question one' } }),
      logId: 's',
      eventId: 'hot-user-1',
    },
    {
      ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'hot answer one' }] } }),
      logId: 's',
      eventId: 'hot-assistant-1',
    },
    {
      ...env({ type: 'user_message', message: { id: 'hot-u2', sender: 'user', text: 'hot question two' } }),
      logId: 's',
      eventId: 'hot-user-2',
    },
    {
      ...env({
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: 'hot answer two' }] },
        state: { previousResponseId: 'old-chain' },
      }),
      logId: 's',
      eventId: 'hot-assistant-2',
    },
  ];
  const hotUserEvent = {
    ...env({ type: 'user_message', message: { id: 'hot-u', sender: 'user', text: 'hot question' } }),
    logId: 's',
    eventId: 'hot-user',
  };
  const hotAssistantEvent = {
    ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'hot answer' }] } }),
    logId: 's',
    eventId: 'hot-assistant',
  };
  const secondHotUserEvent = {
    ...env({ type: 'user_message', message: { id: 'hot-u2', sender: 'user', text: 'hot question two' } }),
    logId: 's',
    eventId: 'hot-user-two',
  };
  const secondHotAssistantEvent = {
    ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'hot answer two' }] } }),
    logId: 's',
    eventId: 'hot-assistant-two',
  };
  const nextUserEvent = {
    ...env({ type: 'user_message', message: { id: 'next-u', sender: 'user', text: 'next question' } }),
    logId: 's',
    eventId: 'next-user',
  };
  const checkpointEvent = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'local-1',
      sourceRefs: [
        { logId: 's', eventId: 'cold-user' },
        { logId: 's', eventId: 'cold-assistant' },
      ],
      item: checkpoint,
    }),
    logId: 's',
    eventId: 'checkpoint',
  };
  const nextAssistantEvent = {
    ...env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'next answer' }] },
      state: { previousResponseId: 'post-checkpoint-chain' },
      providerHistory: [checkpoint, hotUser, hotAssistant, secondHotUser, secondHotAssistant, nextUser, nextAssistant],
    }),
    logId: 's',
    eventId: 'next-assistant',
  };

  const restored = replayEvents([
    sourceUser,
    sourceAssistant,
    hotUserEvent,
    hotAssistantEvent,
    secondHotUserEvent,
    secondHotAssistantEvent,
    nextUserEvent,
    checkpointEvent,
    nextAssistantEvent,
  ]);

  expect(restored.history).toEqual([
    checkpoint,
    hotUser,
    hotAssistant,
    secondHotUser,
    secondHotAssistant,
    nextUser,
    nextAssistant,
  ]);
  expect(restored.previousResponseId).toBe('post-checkpoint-chain');
});

it('replays the production planner/provenance automatic checkpoint before and after current-turn finalization', () => {
  const turn = (n: number) => [
    { role: 'user' as const, type: 'message' as const, content: `user-${n}` },
    { role: 'assistant' as const, type: 'message' as const, content: `answer-${n}` },
  ];
  const history = [
    ...turn(1),
    ...turn(2),
    ...turn(3),
    { role: 'user' as const, type: 'message' as const, content: 'current' },
    { type: 'function_call', callId: 'call-current', name: 'write_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-current', name: 'write_file', output: 'effect committed' },
  ];
  const plan = planLocalCompaction({ history, usableInputTokens: 64_000 });
  expect(plan.kind).toBe('planned');
  if (plan.kind !== 'planned') return;

  const persisted = [
    {
      ...env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'user-1' } }),
      logId: 's',
      eventId: 'u1',
    },
    {
      ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'answer-1' }] } }),
      logId: 's',
      eventId: 'a1',
    },
    {
      ...env({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'user-2' } }),
      logId: 's',
      eventId: 'u2',
    },
    {
      ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'answer-2' }] } }),
      logId: 's',
      eventId: 'a2',
    },
    {
      ...env({ type: 'user_message', message: { id: 'u3', sender: 'user', text: 'user-3' } }),
      logId: 's',
      eventId: 'u3',
    },
    {
      ...env({
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: 'answer-3' }] },
        state: { previousResponseId: 'old-chain' },
      }),
      logId: 's',
      eventId: 'a3',
    },
    {
      ...env({ type: 'user_message', message: { id: 'current', sender: 'user', text: 'current' } }),
      logId: 's',
      eventId: 'current',
    },
    {
      ...env({
        type: 'assistant_journal_item',
        turnId: 'current-turn',
        seq: 1,
        item: { type: 'tool_call', callId: 'call-current', toolName: 'write_file', arguments: '{}' },
      }),
      logId: 's',
      eventId: 'journal-call',
    },
    {
      ...env({
        type: 'assistant_journal_item',
        turnId: 'current-turn',
        seq: 2,
        item: {
          type: 'tool_result',
          callId: 'call-current',
          toolName: 'write_file',
          status: 'completed',
          output: 'effect committed',
        },
      }),
      logId: 's',
      eventId: 'journal-result',
    },
  ];
  const sourceRefs = resolveCheckpointSourceRefs({ envelopes: persisted, history, hotTail: plan.hotTail });
  expect(sourceRefs).toEqual([
    { logId: 's', eventId: 'u1' },
    { logId: 's', eventId: 'a1' },
    { logId: 's', eventId: 'u2' },
    { logId: 's', eventId: 'a2' },
  ]);
  const checkpoint = {
    role: 'system',
    type: 'message',
    content: 'summary',
    contextSummary: { version: 1 as const, strategy: 'local' as const },
  };
  const checkpointEvent = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'automatic',
      sourceRefs: sourceRefs!,
      item: checkpoint,
    }),
    logId: 's',
    eventId: 'checkpoint',
  };
  const interruptedRequest = [
    checkpoint,
    { role: 'user', type: 'message', content: 'user-3' },
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'answer-3' }] },
    { role: 'user', type: 'message', content: 'current' },
    { type: 'function_call', callId: 'call-current', name: 'write_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-current', name: 'write_file', output: 'effect committed' },
  ];
  const atCheckpoint = replayEvents([...persisted, checkpointEvent]);
  expect(deriveLocalCheckpointRequestHistory([...persisted, checkpointEvent], atCheckpoint.history).status).toBe(
    'refused',
  );
  expect(atCheckpoint.history).not.toEqual(interruptedRequest);
  expect(JSON.stringify(atCheckpoint.history)).toContain('answer-1');
  expect(JSON.stringify(atCheckpoint.history)).toContain('call-current');
  expect(JSON.stringify(atCheckpoint.history)).toContain('effect committed');
  expect(atCheckpoint.history.filter((item) => item.content === 'current')).toHaveLength(1);
  expect(atCheckpoint.history.filter((item) => item.callId === 'call-current')).toHaveLength(2);
  expect(atCheckpoint.previousResponseId).toBeNull();

  const nextAssistant = {
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'current answer' }],
  };
  const finalizedAssistantEvent = {
    ...env({
      type: 'assistant_turn',
      turnId: 'current-turn',
      turn: {
        items: [
          { type: 'tool_call', callId: 'call-current', toolName: 'write_file', arguments: '{}' },
          {
            type: 'tool_result',
            callId: 'call-current',
            toolName: 'write_file',
            status: 'completed',
            output: 'effect committed',
          },
          { type: 'assistant_text', text: 'current answer' },
        ],
      },
      state: { previousResponseId: 'new-chain' },
      providerHistory: [...interruptedRequest, nextAssistant],
    }),
    logId: 's',
    eventId: 'current-assistant',
  };
  const finalized = replayEvents([...persisted, checkpointEvent, finalizedAssistantEvent]);
  expect(
    deriveLocalCheckpointRequestHistory(
      [...persisted, checkpointEvent, finalizedAssistantEvent],
      [...interruptedRequest, nextAssistant],
    ),
  ).toMatchObject({ status: 'derived', history: [...interruptedRequest, nextAssistant] });
  expect(
    deriveLocalCheckpointRequestHistory(
      [
        ...persisted,
        checkpointEvent,
        {
          ...finalizedAssistantEvent,
          event: { ...finalizedAssistantEvent.event, turnId: 'unrelated-turn' } as Extract<
            LogEvent,
            { type: 'assistant_turn' }
          >,
        },
      ],
      [...interruptedRequest, nextAssistant],
    ).status,
  ).toBe('refused');
  expect(
    deriveLocalCheckpointRequestHistory(
      [
        ...persisted,
        checkpointEvent,
        finalizedAssistantEvent,
        {
          ...finalizedAssistantEvent,
          seq: finalizedAssistantEvent.seq + 1,
          eventId: 'duplicate-current-assistant',
        },
      ],
      [...interruptedRequest, nextAssistant],
    ).status,
  ).toBe('refused');
  expect(finalized.history).toEqual([...interruptedRequest, nextAssistant]);
  expect(finalized.history.filter((item) => item.content === 'current')).toHaveLength(1);
  expect(JSON.stringify(finalized.history)).not.toContain('answer-1');
  expect(finalized.previousResponseId).toBe('new-chain');
});

it('replay applies a checkpoint appended just before a crash and severs the prior provider chain', () => {
  const checkpoint = {
    role: 'assistant',
    type: 'message',
    content: [{ type: 'output_text', text: 'durable summary' }],
    contextSummary: { version: 1 as const, strategy: 'local' as const },
  };
  const sourceUser = {
    ...env({ type: 'user_message', message: { id: 'cold-u', sender: 'user', text: 'cold question' } }),
    logId: 's',
    eventId: 'cold-user',
  };
  const sourceAssistant = {
    ...env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'cold answer' }] },
      state: { previousResponseId: 'old-chain' },
    }),
    logId: 's',
    eventId: 'cold-assistant',
  };
  const hotUsersAndAssistantEvents = [
    {
      ...env({ type: 'user_message', message: { id: 'hot-u1', sender: 'user', text: 'hot question one' } }),
      logId: 's',
      eventId: 'hot-user-1',
    },
    {
      ...env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'hot answer one' }] } }),
      logId: 's',
      eventId: 'hot-assistant-1',
    },
    {
      ...env({ type: 'user_message', message: { id: 'hot-u2', sender: 'user', text: 'hot question two' } }),
      logId: 's',
      eventId: 'hot-user-2',
    },
    {
      ...env({
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: 'hot answer two' }] },
        state: { previousResponseId: 'old-chain' },
      }),
      logId: 's',
      eventId: 'hot-assistant-2',
    },
  ];
  const currentUserEvent = {
    ...env({ type: 'user_message', message: { id: 'current-u', sender: 'user', text: 'current request' } }),
    logId: 's',
    eventId: 'current-user',
  };
  const checkpointEvent = {
    ...env({
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'local-1',
      sourceRefs: [
        { logId: 's', eventId: 'cold-user' },
        { logId: 's', eventId: 'cold-assistant' },
      ],
      item: checkpoint,
    }),
    logId: 's',
    eventId: 'checkpoint',
  };

  const restored = replayEvents([
    sourceUser,
    sourceAssistant,
    ...hotUsersAndAssistantEvents,
    currentUserEvent,
    checkpointEvent,
  ]);

  expect(restored.history).toHaveLength(6);
  expect(restored.history[0]).toEqual(checkpoint);
  expect(JSON.stringify(restored.history)).toContain('hot question one');
  expect(JSON.stringify(restored.history)).toContain('hot question two');
  expect(JSON.stringify(restored.history)).toContain('current request');
  expect(JSON.stringify(restored.history)).not.toContain('cold answer');
  expect(restored.previousResponseId).toBeNull();
});

it('decodeLogEnvelope requires unique, complete references on events_retracted', () => {
  const valid = env({ type: 'events_retracted', version: 1, refs: [{ logId: 's', eventId: 'e1' }] });
  const duplicate = {
    ...valid,
    event: {
      ...valid.event,
      refs: [
        { logId: 's', eventId: 'e1' },
        { logId: 's', eventId: 'e1' },
      ],
    },
  } as unknown as LogEnvelope;
  const incomplete = {
    ...valid,
    event: { ...valid.event, refs: [{ logId: 's' }] },
  } as unknown as LogEnvelope;

  expect(decodeLogEnvelope(valid)).not.toBeNull();
  expect(decodeLogEnvelope(valid)?.event).toEqual(valid.event);
  expect(decodeLogEnvelope(duplicate)).toBeNull();
  expect(decodeLogEnvelope(incomplete)).toBeNull();
});

it('decodeLogEnvelope accepts legacy checkpoints but rejects malformed present source digests', () => {
  const base = {
    type: 'context_checkpoint_created' as const,
    version: 1 as const,
    artifactId: 'checkpoint',
    sourceRefs: [{ logId: 's', eventId: 'e1' }],
    item: { type: 'message', role: 'assistant', content: 'summary' },
  };
  expect(decodeLogEnvelope(env(base))).not.toBeNull();
  expect(decodeLogEnvelope(env({ ...base, sourceDigest: 'sha256:not-a-digest' }))).toBeNull();
  expect(decodeLogEnvelope(env({ ...base, sourceDigest: 'sha256:' + 'a'.repeat(64) }))).not.toBeNull();
});

it('legacy replay output is unchanged when it encounters a semantic retraction event', () => {
  const source = env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'keep legacy replay' } });
  const retraction = env({ type: 'events_retracted', version: 1, refs: [{ logId: 's', eventId: 'e1' }] });

  expect(replayEvents([source, retraction])).toEqual(replayEvents([source]));
});

it('semantic projection preserves storage truncation markers without treating them as source events', () => {
  const truncated = env({ type: 'assistant_turn', truncated: true, originalSize: 2048 } as unknown as LogEvent);
  const result = projectSemanticEvents([truncated]);
  expect(result.status).toBe('projected');
  if (result.status === 'projected') expect(result.state.replayWarnings).toHaveLength(1);
});

it('semantic projection derives fork and rollover lineage from session events', () => {
  const result = projectSemanticEvents([
    env({
      type: 'session_init',
      id: 'child',
      createdAt: '2026-01-01T00:00:00Z',
      forkedFrom: 'parent',
      rolloverFrom: 'predecessor',
    }),
  ]);
  expect(result).toMatchObject({
    status: 'projected',
    state: { id: 'child', forkedFrom: 'parent', rolloverFrom: 'predecessor' },
  });
});

it('semantic projection treats session_cleared as a settlement marker without replaying or inventing work', () => {
  const result = projectSemanticEvents([
    env({ type: 'session_init', id: 'cleared', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'keep the saved source' } }),
    env({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'saved response' }] } }),
    env({ type: 'session_cleared' }),
  ]);

  expect(result.status).toBe('projected');
  if (result.status === 'projected') {
    expect(result.state.messages).toMatchObject([
      { sender: 'user', text: 'keep the saved source' },
      { sender: 'bot', text: 'saved response' },
    ]);
    expect(result.state.history).toHaveLength(2);
  }
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
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
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

it('replayEvents: compact assistant_turn + ledger pairs + trailing user message keeps one call/result pair in order', () => {
  // Regression for the 2026-08-08 HTTP 400 ("Messages with role 'tool' must
  // be a response to a preceding message with 'tool_calls'"): a compact
  // assistant_turn persists only the turn's last tool result, so replay used
  // to duplicate that result and place a tool_result before its tool_call.
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run diagnostics' } }),
    env({
      type: 'tool_started',
      turnId: 'turn-1',
      toolCallId: 'call-a',
      toolName: 'shell',
      arguments: '{"command":"env"}',
    }),
    env({
      type: 'tool_started',
      turnId: 'turn-1',
      toolCallId: 'call-b',
      toolName: 'shell',
      arguments: '{"command":"pwd"}',
    }),
    env({
      type: 'tool_result',
      turnId: 'turn-1',
      callId: 'call-b',
      toolName: 'shell',
      status: 'completed',
      output: '/repo',
      historyItems: [
        { type: 'function_call', id: 'fc_b', callId: 'call-b', name: 'shell', arguments: '{"command":"pwd"}' },
        { type: 'function_call_result', id: 'fcr_b', callId: 'call-b', name: 'shell', output: '/repo' },
      ],
    }),
    env({
      type: 'tool_result',
      turnId: 'turn-1',
      callId: 'call-a',
      toolName: 'shell',
      status: 'completed',
      output: 'no output',
      historyItems: [
        { type: 'function_call', id: 'fc_a', callId: 'call-a', name: 'shell', arguments: '{"command":"env"}' },
        { type: 'function_call_result', id: 'fcr_a', callId: 'call-a', name: 'shell', output: 'no output' },
      ],
    }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          // Compact v3 shape: only the turn's last tool result survives.
          { type: 'tool_result', callId: 'call-a', toolName: 'shell', status: 'completed', output: 'no output' },
          { type: 'reasoning', text: 'no env vars' },
          { type: 'assistant_text', text: 'Done.' },
        ],
      },
      state: { previousResponseId: 'resp-v3' },
    }),
    // The resumed request: the trailing user message that triggers the
    // history projection in the wild.
    env({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'Reply with exactly: OK' } }),
  ];

  const restored = replayEvents(envelopes);
  const toolItems = restored.history.filter((item: any) => item.callId === 'call-a' || item.callId === 'call-b');

  expect(toolItems.map((item: any) => item.callId)).toEqual(['call-a', 'call-a', 'call-b', 'call-b']);
  expect(toolItems.map((item: any) => item.type)).toEqual([
    'function_call',
    'function_call_result',
    'function_call',
    'function_call_result',
  ]);
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
    env({
      type: 'subagent_started',
      agentId: 'a1',
      role: 'worker',
      task: 'inspect',
      parentTool: 'run_subagent',
      async: true,
    }),
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
  expect(
    restored.messages.find((message: any) => message.sender === 'subagent' && message.agentId === 'a1'),
  ).toMatchObject({ async: true, parentTool: 'run_subagent' });
  expect(restored.messages.some((message: any) => message.sender === 'subagent' && message.agentId === 'a1')).toBe(
    true,
  );
});

it('replayEvents: subagent_transferred freezes the existing card and ignores a later async start', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({
      type: 'subagent_started',
      agentId: 'root-call',
      role: 'explorer',
      task: 'inspect',
      parentTool: 'run_subagent',
    }),
    env({ type: 'subagent_transferred', agentId: 'root-call', runId: 'root-call', role: 'explorer' }),
    env({
      type: 'subagent_started',
      agentId: 'root-call',
      role: 'explorer',
      task: 'inspect',
      parentTool: 'run_subagent',
      async: true,
    }),
    env({
      type: 'subagent_completed',
      result: {
        agentId: 'root-call',
        role: 'explorer',
        status: 'completed',
        finalText: 'done',
        filesChanged: [],
        toolsUsed: [],
      },
    }),
  ]);

  const cards = restored.messages.filter((message) => message.sender === 'subagent');
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    sender: 'subagent',
    agentId: 'root-call',
    status: 'backgrounded',
  });
  expect(cards[0]).not.toHaveProperty('finalText');
});

it('replayEvents: subagent_interrupted restores a terminal foreground card', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'subagent_started', agentId: 'a1', role: 'worker', task: 'run tests' }),
    env({
      type: 'subagent_interrupted',
      agentId: 'a1',
      role: 'worker',
      finalText: 'Paused before running tests.',
    }),
  ]);

  expect(restored.messages.find((message) => message.sender === 'subagent')).toMatchObject({
    agentId: 'a1',
    status: 'interrupted',
    finalText: 'Paused before running tests.',
  });
});

it('replayEvents: restores one settled background shell notification without recreating a job', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'background_shell_started', jobId: 'shell-1', command: 'pnpm test' }),
    env({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'completed',
      output: 'exit 0',
    }),
    // Registry event replay is at-least-once; static transcript projection is not.
    env({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'completed',
      output: 'exit 0',
    }),
  ]);

  const notifications = restored.messages.filter(
    (message): message is CommandMessage =>
      message.sender === 'command' && message.toolName === 'background_shell_notification',
  );
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    status: 'completed',
    command: 'background_shell_notification',
    output: 'exit 0',
    toolArgs: { jobs: [{ jobId: 'shell-1', command: 'pnpm test', status: 'completed' }] },
  });
});

it('replayEvents: marks an unresolved background shell job interrupted without restarting it', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'background_shell_started', jobId: 'shell-lost', command: 'pnpm test' }),
  ]);

  expect(restored.messages).toContainEqual(
    expect.objectContaining({
      sender: 'command',
      toolName: 'background_shell_notification',
      status: 'aborted',
      output: expect.stringContaining('interrupted'),
    }),
  );
  expect(restored.replayWarnings.some((warning) => warning.includes('shell-lost'))).toBe(true);
});

it('replayEvents: replays watch firings ahead of the job terminal row in stored order', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'background_shell_started', jobId: 'shell-1', command: 'pnpm test' }),
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 1,
      matchedLines: 'Listening on http://localhost:3000',
    }),
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 2,
      matchedLines: 'error TS2345',
      droppedBytes: 512,
    }),
    env({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'completed',
      output: 'exit 0',
    }),
  ]);

  const rows = restored.messages.filter(
    (message): message is CommandMessage => message.sender === 'command' && message.toolName !== undefined,
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    toolName: 'background_shell_output_notification',
    output: 'Listening on http://localhost:3000',
    toolArgs: { jobId: 'shell-1', watchId: 'watch-1', seq: 1, matchedLines: 'Listening on http://localhost:3000' },
  });
  expect(rows[1]).toMatchObject({
    toolName: 'background_shell_output_notification',
    output: 'error TS2345',
    toolArgs: { jobId: 'shell-1', watchId: 'watch-1', seq: 2, droppedBytes: 512 },
  });
  // The terminal row stays last: a firing must never read as new activity on a dead job.
  expect(rows[2]).toMatchObject({
    toolName: 'background_shell_notification',
    output: 'exit 0',
  });
});

it('replayEvents: preserves chronological order of background shell notifications and subsequent assistant turns', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'launch monitor' } }),
    env({ type: 'background_shell_started', jobId: 'shell-1', command: 'gh run watch' }),
    env({
      type: 'assistant_turn',
      turnId: 'turn-1',
      turn: { items: [{ type: 'assistant_text', text: 'Started monitor.' }] },
    }),
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'gh run watch',
      watchId: 'watch-1',
      seq: 1,
      matchedLines: 'CI is running',
    }),
    env({
      type: 'assistant_turn',
      turnId: 'turn-2',
      turn: { items: [{ type: 'assistant_text', text: 'CI update: in progress.' }] },
    }),
    env({
      type: 'background_shell_completed',
      jobId: 'shell-1',
      command: 'gh run watch',
      status: 'completed',
      output: 'exit 0',
    }),
    env({
      type: 'assistant_turn',
      turnId: 'turn-3',
      turn: { items: [{ type: 'assistant_text', text: 'Fixed and verified.' }] },
    }),
  ]);

  const messages = restored.messages;
  expect(messages.map((m) => `${m.sender}:${(m as any).toolName ?? (m as any).text}`)).toEqual([
    'user:launch monitor',
    'bot:Started monitor.',
    'command:background_shell_output_notification',
    'bot:CI update: in progress.',
    'command:background_shell_notification',
    'bot:Fixed and verified.',
  ]);
});

it('replayEvents: renders firings for a job that never settled and dedupes by watchId:seq', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 1,
      matchedLines: 'first line',
    }),
    // Registry events are at-least-once: the same firing redelivered must not duplicate.
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 1,
      matchedLines: 'first line',
    }),
    // A different watch may reuse the same seq; both belong in the transcript.
    env({
      type: 'background_shell_output',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-2',
      seq: 1,
      matchedLines: 'second watch line',
    }),
  ]);

  const firingRows = restored.messages.filter(
    (message): message is CommandMessage =>
      message.sender === 'command' && message.toolName === 'background_shell_output_notification',
  );
  expect(firingRows.map((row) => row.output)).toEqual(['first line', 'second watch line']);
  // The job never settled, so the interrupted row follows the firings.
  expect(restored.messages).toContainEqual(
    expect.objectContaining({ sender: 'command', toolName: 'background_shell_notification', status: 'aborted' }),
  );
  expect(restored.replayWarnings.some((warning) => warning.includes('shell-1'))).toBe(true);
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
  expect((restored.messages[1] as ReasoningMessage).text).toBe('thinking');
  expect((restored.messages[1] as ReasoningMessage).status).toBe('finalized');
  expect(restored.messages[2].sender).toBe('command');
  expect((restored.messages[2] as CommandMessage).callId).toBe('call-1');
  expect((restored.messages[2] as CommandMessage).status).toBe('completed');
  expect((restored.messages[2] as CommandMessage).success).toBe(true);
  expect((restored.messages[2] as CommandMessage).output).toBe('files');
  expect(restored.messages[3].sender).toBe('bot');
  expect((restored.messages[3] as BotMessage).text).toBe('here is files');
  expect((restored.messages[3] as BotMessage).usage).toBe(undefined);
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
  // No error/message/path/summary keys; pretty-printed JSON is the contract.
  expect(command?.output as string).toMatch(/^\{\n {2}"unexpected": \{/);
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  const command = restored.messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1');
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
  expect((restored.messages[2] as BotMessage).usage).toEqual({
    prompt_tokens: 3000,
    completion_tokens: 120,
    total_tokens: 3120,
  });
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
  expect((restored.messages[2] as BotMessage).usage).toBe(undefined);
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
  expect((restored.messages[1] as CommandMessage).callId).toBe('call-1');
  expect((restored.messages[1] as CommandMessage).status).toBe('completed');
  expect(restored.messages[2].sender).toBe('bot');
  expect((restored.messages[2] as BotMessage).text).toBe('done');
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

it('replayEvents: assistant_turn serializes persisted object tool-call arguments for resume', () => {
  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'status' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          {
            type: 'tool_call',
            callId: 'call-1',
            toolName: 'shell',
            arguments: {
              command: 'git status --short',
              timeout_ms: 120000,
              max_output_length: 12000,
              sandbox: 'default',
            },
          },
        ],
      },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.history[1]).toEqual({
    type: 'function_call',
    callId: 'call-1',
    name: 'shell',
    arguments: '{"command":"git status --short","timeout_ms":120000,"max_output_length":12000,"sandbox":"default"}',
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
  const commandMsg = restored.messages.find(
    (m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1',
  );
  expect(commandMsg).toBeTruthy();
  expect(commandMsg?.status).toBe('completed');
  expect(commandMsg?.output).toBe('/repo');
});

it('replayEvents: interrupted journal restores an opaque OpenAI compaction item', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'Continue' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', id: 'cmp-1', encrypted_content: 'ciphertext' },
      },
    }),
  ]);

  expect(restored.history).toContainEqual({
    type: 'compaction',
    id: 'cmp-1',
    encrypted_content: 'ciphertext',
    providerOpaque: { provider: 'openai' },
  });
  expect(normalizeApplicationInput(restored.history as any)).toContainEqual({
    type: 'provider_opaque',
    provider: 'openai',
    item: { type: 'compaction', id: 'cmp-1', encrypted_content: 'ciphertext' },
  });
});

it('replayEvents: interrupted journal projects native tool aliases into history and ledger', () => {
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'tool_call',
        callId: 'persisted-call',
        toolName: 'shell',
        arguments: 'fallback arguments',
        providerItem: {
          type: 'function_call',
          tool_call_id: 'provider-call',
          name: 'shell',
          args: { command: 'pwd' },
          providerData: { vendor_trace: 'trace-1' },
        },
      },
    }),
    env({
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 2,
      item: {
        type: 'tool_result',
        callId: 'persisted-call',
        toolName: 'shell',
        status: 'completed',
        output: 'fallback output',
        providerItem: {
          type: 'function_call_result',
          call_id: 'provider-call',
          name: 'shell',
          result: { stdout: '/repo' },
          providerData: { vendor_trace: 'trace-2' },
        },
      },
    }),
  ]);

  const call = restored.history.find((item: any) => item.type === 'function_call') as any;
  const result = restored.history.find((item: any) => item.type === 'function_call_result') as any;

  expect(call).toMatchObject({
    tool_call_id: 'provider-call',
    callId: 'provider-call',
    arguments: '{"command":"pwd"}',
    providerData: { vendor_trace: 'trace-1' },
  });
  expect(result).toMatchObject({
    call_id: 'provider-call',
    callId: 'provider-call',
    output: { stdout: '/repo' },
    providerData: { vendor_trace: 'trace-2' },
  });
  expect(restored.toolLedger[0].historyItems).toEqual([call, result]);
});

it('replayEvents: journal-backed pending tool call remains started after crash recovery', () => {
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
      type: 'tool_started',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'shell',
      arguments: { command: 'pwd' },
    }),
  ];

  const restored = replayEvents(envelopes);

  expect(restored.toolLedger).toHaveLength(1);
  expect(restored.toolLedger[0]).toMatchObject({
    turnId: 'turn-1',
    callId: 'call-1',
    toolName: 'shell',
    status: 'started',
  });
  expect(restored.history.some((h: any) => h.type === 'function_call' && h.callId === 'call-1')).toBe(true);
  expect(restored.replayWarnings).toContain('Previous turn was interrupted.');
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
  const commandMsgs = restored.messages.filter(
    (m): m is CommandMessage => m.sender === 'command' && m.callId === 'call-1',
  );
  expect(commandMsgs.length).toBe(1);
  expect(commandMsgs[0].status).toBe('completed');
  expect(commandMsgs[0].output).toBe('/repo');
});

it.each([
  {
    name: 'direct provider items',
    reasoning: { type: 'reasoning', rawContent: [{ type: 'reasoning_text', text: 'check pwd' }] },
    result: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: '/repo' },
  },
  {
    name: 'wrapped provider items',
    reasoning: { rawItem: { type: 'reasoning', rawContent: [{ type: 'reasoning_text', text: 'check pwd' }] } },
    result: { rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: '/repo' } },
  },
  {
    name: 'canonical items',
    reasoning: { type: 'reasoning', text: 'check pwd' },
    result: {
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: '/repo',
    },
  },
])('replayEvents: preserves and recognizes $name in existing tool history', ({ reasoning, result }) => {
  const historyItems = [
    reasoning,
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' },
    result,
  ];
  const restored = replayEvents([
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'run pwd' } }),
    env({
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: '/repo',
      historyItems,
    }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'reasoning', text: 'check pwd' },
          { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{"command":"pwd"}' },
          { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: '/repo' },
        ],
      },
      state: { previousResponseId: 'resp-1' },
    }),
  ]);

  expect(restored.toolLedger[0].historyItems).toEqual(historyItems);
});

it('decodeLogEnvelope: rejects malformed known events without losing surrounding valid events', () => {
  const rawEvents: unknown[] = [
    { event: { type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' } },
    { event: { type: 'user_message', message: null } },
    { event: { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } } },
    { event: { type: 'assistant_turn', turn: { items: null } } },
    { event: { type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'answer' }] } } },
    { event: { type: 'undo', removedUserTurns: 1, snapshot: null } },
    { event: { type: 'user_message', message: { id: 'u2', sender: 'user', text: 'still here' } } },
    { event: { type: 'session_init', id: 7, createdAt: 'invalid' } },
  ];

  const decoded = rawEvents
    .map((value) => decodeLogEnvelope(value))
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const restored = replayEvents(decoded);

  expect(decoded.map(({ event }) => event.type)).toEqual([
    'session_init',
    'user_message',
    'assistant_turn',
    'user_message',
  ]);
  expect(restored.id).toBe('sess');
  expect(restored.messages.slice(0, 3).map((message) => ('text' in message ? message.text : undefined))).toEqual([
    'hello',
    'answer',
    'still here',
  ]);
});

it('decodeLogEnvelope: validates the closed background shell lifecycle fields', () => {
  expect(
    decodeLogEnvelope({
      event: { type: 'background_shell_started', jobId: 'shell-1', command: 'pnpm test' },
    })?.event,
  ).toMatchObject({ type: 'background_shell_started', jobId: 'shell-1' });
  expect(
    decodeLogEnvelope({
      event: {
        type: 'background_shell_completed',
        jobId: 'shell-1',
        command: 'pnpm test',
        status: 'timed_out',
        output: 'timeout',
      },
    })?.event,
  ).toMatchObject({ type: 'background_shell_completed', status: 'timed_out' });
  expect(
    decodeLogEnvelope({
      event: { type: 'background_shell_completed', jobId: 'shell-1', command: 'pnpm test', status: 'running' },
    }),
  ).toBeNull();
});

it('decodeLogEnvelope: validates the shell watch firing shape', () => {
  expect(
    decodeLogEnvelope({
      event: {
        type: 'background_shell_output',
        jobId: 'shell-1',
        command: 'pnpm test',
        watchId: 'watch-1',
        seq: 3,
        matchedLines: 'error TS2345',
        droppedBytes: 512,
      },
    })?.event,
  ).toMatchObject({
    type: 'background_shell_output',
    jobId: 'shell-1',
    watchId: 'watch-1',
    seq: 3,
    matchedLines: 'error TS2345',
  });
  expect(
    decodeLogEnvelope({
      event: { type: 'background_shell_output', jobId: 'shell-1', command: 'pnpm test', watchId: 'watch-1', seq: 3 },
    }),
  ).toBeNull();
  expect(
    decodeLogEnvelope({
      event: {
        type: 'background_shell_output',
        jobId: 'shell-1',
        command: 'pnpm test',
        watchId: 'watch-1',
        seq: 'three',
        matchedLines: 'oops',
      },
    }),
  ).toBeNull();
});

it('decodeLogEnvelope: skips invalid closed discriminants while retaining surrounding events', () => {
  const decoded = [
    { event: { type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' } },
    { event: { type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'image', delta: 'bad' } },
    { event: { type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'pending' } },
    { event: { type: 'approval_resolved', answer: 'maybe' } },
    { event: { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'survived' } } },
  ]
    .map((value) => decodeLogEnvelope(value))
    .filter((value): value is NonNullable<typeof value> => value !== null);

  expect(decoded.map(({ event }) => event.type)).toEqual(['session_init', 'user_message']);
  expect(replayEvents(decoded).messages[0]).toMatchObject({ sender: 'user', text: 'survived' });
});

it('decodeLogEnvelope: validates known assistant items but preserves unknown item types', () => {
  const decodeItems = (items: unknown[]) =>
    decodeLogEnvelope({ event: { type: 'assistant_turn', turn: { items }, state: { previousResponseId: null } } });

  expect(decodeItems([{ type: 'reasoning' }])).toBe(null);
  expect(decodeItems([{ type: 'assistant_text', text: 42 }])).toBe(null);
  expect(decodeItems([{ type: 'tool_call', callId: null, toolName: 'shell' }])).toBe(null);
  expect(decodeItems([{ type: 'tool_result', callId: 'c1', toolName: 'shell', status: 'pending' }])).toBe(null);
  expect(
    decodeLogEnvelope({
      event: { type: 'assistant_journal_item', turnId: 't1', seq: 1, item: { type: 'tool_call', toolName: 'shell' } },
    }),
  ).toBe(null);

  expect(decodeItems([{ type: 'future_assistant_item', opaque: true }])).not.toBe(null);
  expect(
    decodeLogEnvelope({
      event: { type: 'assistant_journal_item', turnId: 't1', seq: 1, item: { type: 'future_item', opaque: true } },
    }),
  ).not.toBe(null);
  expect(decodeItems([{ type: 'assistant_text', text: 'valid after malformed items' }])).not.toBe(null);
});

it('decodeLogEnvelope: preserves unknown future event objects for no-op replay', () => {
  const future = decodeLogEnvelope({
    v: 99,
    seq: 2,
    ts: '2030-01-01T00:00:00Z',
    event: { type: 'future_checkpoint', payload: { opaque: true } },
  });

  expect(future?.event).toEqual({ type: 'future_checkpoint', payload: { opaque: true } });
  expect(replayEvents(future ? [future] : []).messages).toEqual([]);
});

it('decodeLogEnvelope and decodeSavedMessage: validate structure while retaining forward-compatible fields', () => {
  expect(decodeLogEnvelope(null)).toBe(null);
  expect(decodeLogEnvelope('invalid')).toBe(null);
  expect(decodeLogEnvelope({ event: 'not-an-object' })).toBe(null);

  const envelope = decodeLogEnvelope({
    v: 3,
    seq: 42,
    ts: '2026-08-01T00:00:00Z',
    event: { type: 'user_message', message: { id: 'm1', sender: 'user', text: 'hello' } },
    futureMeta: 'opaque',
  });
  expect(envelope).not.toBe(null);
  expect(envelope?.v).toBe(3);
  expect(envelope?.seq).toBe(42);
  expect(envelope?.event.type).toBe('user_message');

  const truncated = decodeLogEnvelope({
    v: 3,
    seq: 43,
    ts: '2026-08-01T00:00:00Z',
    event: { type: 'assistant_turn', truncated: true, originalSize: 500000 },
  });
  expect(truncated !== null && 'truncated' in truncated.event && truncated.event.truncated).toBe(true);

  expect(decodeSavedMessage(null)).toBe(null);
  expect(decodeSavedMessage({ id: 123 })).toBe(null);

  const savedMsg = decodeSavedMessage({
    id: 'msg-1',
    sender: 'user',
    text: 'hello',
    unknownFutureField: 123,
  });
  expect(savedMsg).not.toBe(null);
  expect(savedMsg?.id).toBe('msg-1');
});

it('decodeLogEnvelope: roundtrips optional event and stream identities', () => {
  const value = {
    v: LOG_ENVELOPE_VERSION,
    seq: 7,
    ts: '2026-01-01T00:00:00Z',
    logId: 'stream-a',
    eventId: 'event-a',
    event: { type: 'session_cleared' },
  };
  expect(decodeLogEnvelope(value)).toEqual(value);
});

it('decodeLogEnvelope: ignores malformed optional identities without dropping the event', () => {
  const decoded = decodeLogEnvelope({
    v: 3,
    seq: 2,
    ts: 'old',
    logId: '',
    eventId: 42,
    event: { type: 'session_cleared' },
  });
  expect(decoded).toMatchObject({ seq: 2, event: { type: 'session_cleared' } });
  expect(decoded).not.toHaveProperty('logId');
  expect(decoded).not.toHaveProperty('eventId');
});

it('resolveEnvelopeIdentities: repeated legacy sequences get stable distinct references', () => {
  const firstEnvelope = decodeLogEnvelope({ v: 3, seq: 12, ts: 'old', event: { type: 'session_cleared' } })!;
  const secondEnvelope = decodeLogEnvelope({ v: 3, seq: 12, ts: 'old2', event: { type: 'session_cleared' } })!;
  const envelopes = [firstEnvelope, secondEnvelope];
  const firstRead = resolveEnvelopeIdentities(envelopes, 'session-a');
  const secondRead = resolveEnvelopeIdentities(envelopes, 'session-a');
  expect(firstRead).toEqual(secondRead);
  expect(firstRead.map((envelope) => [envelope.logId, envelope.eventId])).toEqual([
    ['session-a', 'legacy:session-a:12'],
    ['session-a', 'legacy:session-a:12:2'],
  ]);
  expect(resolveEnvelopeIdentities(envelopes, 'session-b')[0]?.eventId).not.toBe(firstRead[0]?.eventId);
});

it('resolveEnvelopeIdentities: only repeated explicit event IDs are deduplicated', () => {
  const first = decodeLogEnvelope({
    v: 3,
    seq: 1,
    ts: 'first',
    eventId: 'persisted-1',
    event: { type: 'session_cleared' },
  })!;
  const repeated = decodeLogEnvelope({
    v: 3,
    seq: 1,
    ts: 'second',
    eventId: 'persisted-1',
    event: { type: 'session_cleared' },
  })!;
  const distinctLegacy = decodeLogEnvelope({ v: 3, seq: 1, ts: 'third', event: { type: 'session_cleared' } })!;
  expect(resolveEnvelopeIdentities([first, repeated, distinctLegacy], 'stream')).toMatchObject([
    { eventId: 'persisted-1' },
    { eventId: 'legacy:stream:1' },
  ]);
});

// Step 2 of docs/plans/openai-context-compaction.md: an opaque provider item
// (e.g. an OpenAI `compaction` item) persisted via `assistant_turn` must
// replay back into `ConversationStore` history byte-identical — unknown
// fields and key order intact — and carrying the `providerOpaque` marker so
// `normalizeInputItem` (application-run-loop.ts) re-carries it on the next
// request instead of throwing `Unsupported restored input item type: …`.
it('replayEvents: a provider_opaque item round-trips byte-identical through persistence and replay', () => {
  const opaqueItem = {
    type: 'compaction',
    id: 'comp_9',
    created_by: 'model',
    encrypted_content: 'ciphertext-'.repeat(50),
    // Field the app does not know about today — must survive untouched, in
    // place, rather than being dropped or reshaped by a typed schema.
    a_future_field: { z: 1, a: 2, list: ['x', 'y'] },
  };

  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z', model: 'gpt-5.4', provider: 'openai' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'keep going' } }),
    env({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'assistant_text', text: 'Continuing.' },
          { type: 'provider_opaque', provider: 'openai', item: opaqueItem },
        ],
      },
      state: { previousResponseId: 'resp-1', model: 'gpt-5.4', provider: 'openai' },
    }),
  ];

  const restored = replayEvents(envelopes);
  const replayedOpaque = restored.history.find(
    (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'compaction',
  ) as Record<string, unknown>;

  expect(replayedOpaque).toBeTruthy();

  // Byte-identical: same fields, same values, same key order (the opaque
  // item's own keys, in their original order, plus the marker appended).
  expect(Object.keys(replayedOpaque)).toEqual([...Object.keys(opaqueItem), 'providerOpaque']);
  expect(JSON.stringify(replayedOpaque)).toBe(
    JSON.stringify({ ...opaqueItem, providerOpaque: { provider: 'openai' } }),
  );

  // The providerOpaque marker must be present and recognized by the run
  // loop's own normalizer rather than hitting the unsupportedInput throw.
  expect(replayedOpaque.providerOpaque).toEqual({ provider: 'openai' });
  const normalized = normalizeApplicationInput([replayedOpaque]);
  expect(normalized).toEqual([{ type: 'provider_opaque', provider: 'openai', item: opaqueItem }]);
});

it('replayEvents: two provider_opaque items across turns both survive independently', () => {
  const first = { type: 'compaction', id: 'c1', encrypted_content: 'first-blob' };
  const second = { type: 'compaction', id: 'c2', encrypted_content: 'second-blob' };

  const envelopes: LogEnvelope[] = [
    env({ type: 'session_init', id: 'sess', createdAt: '2026-01-01T00:00:00Z' }),
    env({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'go' } }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'provider_opaque', provider: 'openai', item: first }] },
      state: { previousResponseId: 'r1' },
    }),
    env({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'again' } }),
    env({
      type: 'assistant_turn',
      turn: { items: [{ type: 'provider_opaque', provider: 'openai', item: second }] },
      state: { previousResponseId: 'r2' },
    }),
  ];

  const restored = replayEvents(envelopes);
  const opaqueEntries = restored.history.filter(
    (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'compaction',
  );

  expect(opaqueEntries).toEqual([
    { ...first, providerOpaque: { provider: 'openai' } },
    { ...second, providerOpaque: { provider: 'openai' } },
  ]);
});
