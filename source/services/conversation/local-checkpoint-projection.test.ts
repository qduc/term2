import { describe, expect, it } from 'vitest';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { deriveLocalCheckpointRequestHistory } from './local-checkpoint-projection.js';

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
    expect(deriveLocalCheckpointRequestHistory(persisted, request)).toEqual({ status: 'derived', history: request });
  });
});
