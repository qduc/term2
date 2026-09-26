import { expect, it } from 'vitest';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import { resolveCheckpointSourceRefs } from './conversation-checkpoint-provenance.js';

const envelope = (seq: number, event: PersistedLogEnvelope['event']): PersistedLogEnvelope => ({
  v: 3,
  seq,
  ts: new Date(seq).toISOString(),
  logId: 'session-1',
  eventId: `event-${seq}`,
  event,
});

const user = (text: string): ProviderInputItem => ({ type: 'message', role: 'user', content: text });

it('resolves only summarized turns to persisted refs and excludes hot-tail turns', () => {
  const envelopes = [
    envelope(1, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'cold' } }),
    envelope(2, { type: 'assistant_turn', turn: { items: [] } }),
    envelope(3, { type: 'user_message', message: { id: 'u2', sender: 'user', text: 'hot 1' } }),
    envelope(4, { type: 'assistant_turn', turn: { items: [] } }),
    envelope(5, { type: 'user_message', message: { id: 'u3', sender: 'user', text: 'hot 2' } }),
    envelope(6, { type: 'assistant_turn', turn: { items: [] } }),
  ];
  const history = [user('cold'), user('hot 1'), user('hot 2')];
  const sourceRefs = resolveCheckpointSourceRefs({ envelopes, history, hotTail: history.slice(1) });

  expect(sourceRefs).toEqual([
    { logId: 'session-1', eventId: 'event-1' },
    { logId: 'session-1', eventId: 'event-2' },
  ]);
  expect(envelopes.filter((entry) => sourceRefs?.some((ref) => ref.eventId === entry.eventId))).toHaveLength(2);
});

it('does not invent coverage when a summarized turn has no persisted assistant turn', () => {
  const envelopes = [envelope(1, { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'cold' } })];
  expect(
    resolveCheckpointSourceRefs({
      envelopes,
      history: [user('cold'), user('hot 1'), user('hot 2')],
      hotTail: [user('hot 1'), user('hot 2')],
    }),
  ).toBeNull();
});
