import { describe, expect, it } from 'vitest';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { deriveLocalCheckpointRequestHistory } from './local-checkpoint-projection.js';
import { planLocalCompaction } from '../agent-runtime/context-compaction/index.js';
import { resolveCheckpointSourceRefs } from './conversation-checkpoint-provenance.js';

const envelope = (seq: number, eventId: string, event: Record<string, unknown>): PersistedLogEnvelope => ({
  v: 3,
  seq,
  ts: new Date(seq * 1000).toISOString(),
  logId: 'session',
  eventId,
  event: event as PersistedLogEnvelope['event'],
});

const assistantTurn = (text: string) => ({
  type: 'assistant_turn',
  turn: { items: [{ type: 'assistant_text', text }] },
});

describe('deriveLocalCheckpointRequestHistory', () => {
  it('returns no checkpoint for old logs and remains compatible with their safe replay', () => {
    expect(deriveLocalCheckpointRequestHistory([], [{ role: 'user', content: 'legacy' }])).toEqual({
      status: 'no_checkpoint',
    });
  });

  it('derives checkpoint plus uncovered source turns and requires exact snapshot agreement', () => {
    const checkpoint: ProviderInputItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'summary' }],
      contextSummary: { version: 1, strategy: 'local' },
    };
    const tailUser = { role: 'user', type: 'message', content: 'hot question' };
    const tailAssistant = {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hot answer' }],
    };
    const secondTailUser = { role: 'user', type: 'message', content: 'hot question two' };
    const secondTailAssistant = {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hot answer two' }],
    };
    const nextAssistant = {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'next answer' }],
    };
    const events = [
      envelope(1, 'u1', { type: 'user_message', message: { sender: 'user', text: 'cold question' } }),
      envelope(2, 'a1', assistantTurn('cold answer')),
      envelope(3, 'u2', { type: 'user_message', message: { sender: 'user', text: 'hot question' } }),
      envelope(4, 'a2', assistantTurn('hot answer')),
      envelope(5, 'u3', { type: 'user_message', message: { sender: 'user', text: 'hot question two' } }),
      envelope(6, 'a3', assistantTurn('hot answer two')),
      envelope(7, 'checkpoint', {
        type: 'context_checkpoint_created',
        version: 1,
        artifactId: 'c1',
        sourceRefs: [
          { logId: 'session', eventId: 'u1' },
          { logId: 'session', eventId: 'a1' },
        ],
        item: checkpoint,
      }),
      envelope(8, 'a4', {
        ...assistantTurn('next answer'),
        providerHistory: [
          checkpoint,
          tailUser,
          tailAssistant,
          secondTailUser,
          secondTailAssistant,
          {
            role: 'assistant',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'next answer' }],
          },
        ],
      }),
    ];
    const request = [checkpoint, tailUser, tailAssistant, secondTailUser, secondTailAssistant, nextAssistant];

    expect(deriveLocalCheckpointRequestHistory(events, request)).toEqual({
      status: 'derived',
      history: request,
      postCheckpointTurnFinalized: true,
    });
  });

  it('keeps the current pre-checkpoint user at the hot-tail boundary before and after its final answer', () => {
    const checkpoint: ProviderInputItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'summary' }],
      contextSummary: { version: 1, strategy: 'local' },
    };
    const hotHistory = [
      { role: 'user', type: 'message', content: 'hot one' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer one' }],
      },
      { role: 'user', type: 'message', content: 'hot two' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer two' }],
      },
    ];
    const currentUser = { role: 'user', type: 'message', content: 'current request' };
    const prefix = [
      envelope(1, 'cold-user', { type: 'user_message', message: { sender: 'user', text: 'cold question' } }),
      envelope(2, 'cold-assistant', assistantTurn('cold answer')),
      envelope(3, 'hot-user-1', { type: 'user_message', message: { sender: 'user', text: 'hot one' } }),
      envelope(4, 'hot-assistant-1', assistantTurn('answer one')),
      envelope(5, 'hot-user-2', { type: 'user_message', message: { sender: 'user', text: 'hot two' } }),
      envelope(6, 'hot-assistant-2', assistantTurn('answer two')),
      envelope(7, 'current-user', { type: 'user_message', message: { sender: 'user', text: 'current request' } }),
      envelope(8, 'checkpoint', {
        type: 'context_checkpoint_created',
        version: 1,
        artifactId: 'automatic-local',
        sourceRefs: [
          { logId: 'session', eventId: 'cold-user' },
          { logId: 'session', eventId: 'cold-assistant' },
        ],
        item: checkpoint,
      }),
    ];
    const interruptedRequest = [checkpoint, ...hotHistory, currentUser];
    const interrupted = deriveLocalCheckpointRequestHistory(prefix, [
      { role: 'user', type: 'message', content: 'cold question' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'cold answer' }],
      },
      ...hotHistory,
      currentUser,
    ]);
    expect(interrupted).toEqual({
      status: 'derived',
      history: interruptedRequest,
      postCheckpointTurnFinalized: false,
    });

    const finalizedResponse = {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'current answer' }],
    };
    const finalized = deriveLocalCheckpointRequestHistory(
      [
        ...prefix,
        envelope(9, 'current-assistant', {
          ...assistantTurn('current answer'),
          providerHistory: [...interruptedRequest, finalizedResponse],
        }),
      ],
      [...interruptedRequest, finalizedResponse],
    );
    expect(finalized).toEqual({
      status: 'derived',
      history: [...interruptedRequest, finalizedResponse],
      postCheckpointTurnFinalized: true,
    });
  });

  it('projects the production compaction plan and provenance resolver event order', () => {
    const checkpoint: ProviderInputItem = {
      role: 'system',
      type: 'message',
      content: 'summary',
      contextSummary: { version: 1, strategy: 'local' },
    };
    const turn = (n: number): ProviderInputItem[] => [
      { role: 'user', type: 'message', content: `user-${n}` },
      { type: 'function_call', callId: `call-${n}`, name: 'read', arguments: '{}' },
      { type: 'function_call_result', callId: `call-${n}`, name: 'read', output: `result-${n}` },
      { role: 'assistant', type: 'message', content: `answer-${n}` },
    ];
    const history = [...turn(1), ...turn(2), ...turn(3), { role: 'user', type: 'message', content: 'current' }];
    const plan = planLocalCompaction({ history, usableInputTokens: 64_000 });
    expect(plan.kind).toBe('planned');
    if (plan.kind !== 'planned') return;
    expect(plan.coldPrefix).toEqual([...turn(1), ...turn(2)]);
    expect(plan.hotTail).toEqual([...turn(3), { role: 'user', type: 'message', content: 'current' }]);

    const persisted = [
      envelope(1, 'u1', { type: 'user_message', message: { sender: 'user', text: 'user-1' } }),
      envelope(2, 'a1', {
        type: 'assistant_turn',
        turn: {
          items: [
            { type: 'tool_call', callId: 'call-1', toolName: 'read', arguments: '{}' },
            { type: 'tool_result', callId: 'call-1', toolName: 'read', output: 'result-1', status: 'completed' },
            { type: 'assistant_text', text: 'answer-1' },
          ],
        },
      }),
      envelope(3, 'u2', { type: 'user_message', message: { sender: 'user', text: 'user-2' } }),
      envelope(4, 'a2', {
        type: 'assistant_turn',
        turn: {
          items: [
            { type: 'tool_call', callId: 'call-2', toolName: 'read', arguments: '{}' },
            { type: 'tool_result', callId: 'call-2', toolName: 'read', output: 'result-2', status: 'completed' },
            { type: 'assistant_text', text: 'answer-2' },
          ],
        },
      }),
      envelope(5, 'u3', { type: 'user_message', message: { sender: 'user', text: 'user-3' } }),
      envelope(6, 'a3', {
        type: 'assistant_turn',
        turn: {
          items: [
            { type: 'tool_call', callId: 'call-3', toolName: 'read', arguments: '{}' },
            { type: 'tool_result', callId: 'call-3', toolName: 'read', output: 'result-3', status: 'completed' },
            { type: 'assistant_text', text: 'answer-3' },
          ],
        },
      }),
      envelope(7, 'current', { type: 'user_message', message: { sender: 'user', text: 'current' } }),
    ];
    const sourceRefs = resolveCheckpointSourceRefs({ envelopes: persisted, history, hotTail: plan.hotTail });
    expect(sourceRefs).toEqual([
      { logId: 'session', eventId: 'u1' },
      { logId: 'session', eventId: 'a1' },
      { logId: 'session', eventId: 'u2' },
      { logId: 'session', eventId: 'a2' },
    ]);
    const checkpointEvent = envelope(8, 'checkpoint', {
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'production-plan',
      sourceRefs: sourceRefs!,
      item: checkpoint,
    });
    const persistedHotTail: ProviderInputItem[] = [
      { role: 'user', type: 'message', content: 'user-3' },
      { type: 'function_call', callId: 'call-3', name: 'read', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-3', name: 'read', output: 'result-3' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'answer-3' }] },
      { role: 'user', type: 'message', content: 'current' },
    ];
    const interruptedRequest = [checkpoint, ...persistedHotTail];
    const replayedBefore = [history[0]!, ...history.slice(1)];
    expect(deriveLocalCheckpointRequestHistory([...persisted, checkpointEvent], replayedBefore)).toMatchObject({
      status: 'derived',
      history: interruptedRequest,
      postCheckpointTurnFinalized: false,
    });

    const currentAssistant = envelope(9, 'current-assistant', {
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: 'current answer' }] },
      providerHistory: [
        ...interruptedRequest,
        {
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'current answer' }],
        },
      ],
    });
    expect(
      deriveLocalCheckpointRequestHistory(
        [...persisted, checkpointEvent, currentAssistant],
        [
          ...interruptedRequest,
          {
            role: 'assistant',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'current answer' }],
          },
        ],
      ),
    ).toMatchObject({ status: 'derived', postCheckpointTurnFinalized: true });
  });

  it('refuses a one-complete-turn tail without a current user and refuses a lone current user', () => {
    const checkpoint: ProviderInputItem = {
      role: 'system',
      type: 'message',
      content: 'summary',
      contextSummary: { version: 1, strategy: 'local' },
    };
    const cold = [
      envelope(1, 'cold-user', { type: 'user_message', message: { sender: 'user', text: 'cold' } }),
      envelope(2, 'cold-assistant', assistantTurn('cold answer')),
    ];
    const hot = [
      envelope(3, 'hot-user', { type: 'user_message', message: { sender: 'user', text: 'hot' } }),
      envelope(4, 'hot-assistant', assistantTurn('hot answer')),
    ];
    const checkpointEvent = envelope(5, 'checkpoint', {
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'short-tail',
      sourceRefs: [
        { logId: 'session', eventId: 'cold-user' },
        { logId: 'session', eventId: 'cold-assistant' },
      ],
      item: checkpoint,
    });

    expect(
      deriveLocalCheckpointRequestHistory(
        [...cold, ...hot, checkpointEvent],
        [checkpoint, { role: 'user', content: 'hot' }],
      ),
    ).toEqual({ status: 'refused' });
    const currentUser = envelope(3, 'current-user', {
      type: 'user_message',
      message: { sender: 'user', text: 'current' },
    });
    const checkpointAfterCurrent = envelope(4, 'checkpoint', {
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'short-tail-current',
      sourceRefs: [
        { logId: 'session', eventId: 'cold-user' },
        { logId: 'session', eventId: 'cold-assistant' },
      ],
      item: checkpoint,
    });
    expect(
      deriveLocalCheckpointRequestHistory(
        [...cold, currentUser, checkpointAfterCurrent],
        [checkpoint, { role: 'user', content: 'current' }],
      ),
    ).toMatchObject({ status: 'refused' });
  });

  it('refuses projection when a pre-checkpoint assistant journal has no finalized turn', () => {
    const checkpoint: ProviderInputItem = {
      role: 'system',
      type: 'message',
      content: 'summary',
      contextSummary: { version: 1, strategy: 'local' },
    };
    const envelopes = [
      envelope(1, 'cold-user', { type: 'user_message', message: { sender: 'user', text: 'cold' } }),
      envelope(2, 'cold-assistant', assistantTurn('cold answer')),
      envelope(3, 'hot-user', { type: 'user_message', message: { sender: 'user', text: 'hot' } }),
      envelope(4, 'hot-assistant', assistantTurn('hot answer')),
      envelope(5, 'current-user', { type: 'user_message', message: { sender: 'user', text: 'current' } }),
      envelope(6, 'journal-delta', {
        type: 'assistant_journal_delta',
        turnId: 'open-turn',
        seq: 1,
        kind: 'text',
        delta: 'partial output',
      }),
      envelope(7, 'checkpoint', {
        type: 'context_checkpoint_created',
        version: 1,
        artifactId: 'open-journal',
        sourceRefs: [
          { logId: 'session', eventId: 'cold-user' },
          { logId: 'session', eventId: 'cold-assistant' },
        ],
        item: checkpoint,
      }),
    ];

    expect(deriveLocalCheckpointRequestHistory(envelopes, [checkpoint, { role: 'user', content: 'current' }])).toEqual({
      status: 'refused',
    });
  });

  it('refuses an unresolved source reference without changing the safe history', () => {
    const safeHistory: ProviderInputItem[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'summary' }],
        contextSummary: { version: 1, strategy: 'local' },
      },
    ];
    const events = [
      envelope(1, 'checkpoint', {
        type: 'context_checkpoint_created',
        version: 1,
        artifactId: 'c1',
        sourceRefs: [{ logId: 'session', eventId: 'missing' }],
        item: safeHistory[0],
      }),
    ];

    expect(deriveLocalCheckpointRequestHistory(events, safeHistory)).toEqual({ status: 'refused' });
  });

  it('refuses when the persisted source projection differs from the request snapshot', () => {
    const checkpoint: ProviderInputItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'summary' }],
      contextSummary: { version: 1, strategy: 'local' },
    };
    const events = [
      envelope(1, 'u1', { type: 'user_message', message: { sender: 'user', text: 'cold question' } }),
      envelope(2, 'a1', assistantTurn('cold answer')),
      envelope(3, 'u2', { type: 'user_message', message: { sender: 'user', text: 'hot question one' } }),
      envelope(4, 'a2', assistantTurn('hot answer one')),
      envelope(5, 'u3', { type: 'user_message', message: { sender: 'user', text: 'hot question two' } }),
      envelope(6, 'a3', assistantTurn('hot answer two')),
      envelope(7, 'checkpoint', {
        type: 'context_checkpoint_created',
        version: 1,
        artifactId: 'c1',
        sourceRefs: [
          { logId: 'session', eventId: 'u1' },
          { logId: 'session', eventId: 'a1' },
        ],
        item: checkpoint,
      }),
      envelope(8, 'a4', {
        ...assistantTurn('next answer'),
        providerHistory: [checkpoint, { role: 'user', type: 'message', content: 'changed snapshot' }],
      }),
    ];

    expect(
      deriveLocalCheckpointRequestHistory(events, [
        checkpoint,
        { role: 'user', type: 'message', content: 'changed snapshot' },
      ]),
    ).toEqual({ status: 'refused' });
  });

  it('uses the newest checkpoint transitively and retains only the uncovered hot tail', () => {
    const oldCheckpoint: ProviderInputItem = {
      type: 'message',
      role: 'assistant',
      content: 'old summary',
      contextSummary: { version: 1, strategy: 'local' },
    };
    const newCheckpoint: ProviderInputItem = {
      type: 'message',
      role: 'assistant',
      content: 'new summary',
      contextSummary: { version: 1, strategy: 'local' },
    };
    const turns = [1, 2, 3, 4].flatMap((turn) => [
      envelope(turn === 1 ? 1 : turn * 2, `u${turn}`, {
        type: 'user_message',
        message: { sender: 'user', text: `question ${turn}` },
      }),
      envelope(turn === 1 ? 2 : turn * 2 + 1, `a${turn}`, assistantTurn(`answer ${turn}`)),
    ]);
    const firstCheckpoint = envelope(3, 'checkpoint-1', {
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'c1',
      sourceRefs: [
        { logId: 'session', eventId: 'u1' },
        { logId: 'session', eventId: 'a1' },
      ],
      item: oldCheckpoint,
    });
    const secondCheckpoint = envelope(10, 'checkpoint-2', {
      type: 'context_checkpoint_created',
      version: 1,
      artifactId: 'c2',
      sourceRefs: [
        { logId: 'session', eventId: 'u1' },
        { logId: 'session', eventId: 'a1' },
        { logId: 'session', eventId: 'u2' },
        { logId: 'session', eventId: 'a2' },
      ],
      item: newCheckpoint,
    });
    const turn3 = [
      { role: 'user', type: 'message', content: 'question 3' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'answer 3' }] },
    ];
    const turn4 = [
      { role: 'user', type: 'message', content: 'question 4' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'answer 4' }] },
    ];
    const nextAssistant = {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'answer 5' }],
    };
    const afterCheckpoint = [
      envelope(11, 'u5', { type: 'user_message', message: { sender: 'user', text: 'question 5' } }),
      envelope(12, 'a5', {
        ...assistantTurn('answer 5'),
        providerHistory: [
          newCheckpoint,
          ...turn3,
          ...turn4,
          { role: 'user', type: 'message', content: 'question 5' },
          nextAssistant,
        ],
      }),
    ];
    const request = [
      newCheckpoint,
      ...turn3,
      ...turn4,
      { role: 'user', type: 'message', content: 'question 5' },
      nextAssistant,
    ];

    const persisted = [turns[0]!, turns[1]!, firstCheckpoint, ...turns.slice(2), secondCheckpoint, ...afterCheckpoint];
    expect(deriveLocalCheckpointRequestHistory(persisted, request)).toEqual({
      status: 'derived',
      history: request,
      postCheckpointTurnFinalized: true,
    });
  });
});
