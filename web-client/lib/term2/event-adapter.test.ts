import assert from 'node:assert/strict';
import test from 'node:test';
import { viewFromProjection } from './event-adapter.js';
import type { SessionProjection } from './types.js';

function projection(status: SessionProjection['status'], messages: unknown[]): SessionProjection {
  return {
    id: 'session_1',
    workspaceId: 'workspace_1',
    status,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    latestSequence: 2,
    earliestReplayableSequence: 0,
    projectionSequence: 2,
    transcript: { messages },
    interaction: null,
  } as SessionProjection;
}

test('keeps a live rehydrated prompt in the user bubble and abortable', () => {
  const view = viewFromProjection(
    projection('running', [
      { id: 'turn_1', role: 'user', text: 'keep this as the prompt' },
      { id: 'system-interrupted-1', role: 'assistant', text: 'Previous turn was interrupted' },
    ]),
  );
  assert.deepEqual(view.turns, [
    {
      turnId: 'turn_1',
      role: 'assistant',
      userText: 'keep this as the prompt',
      text: '',
      reasoning: '',
      status: 'streaming',
      commands: [],
    },
  ]);
});

test('pairs a genuinely interrupted prompt with its interruption message', () => {
  const view = viewFromProjection(
    projection('interrupted', [
      { id: 'turn_1', role: 'user', text: 'prompt' },
      { id: 'system-interrupted-1', role: 'assistant', text: 'Previous turn was interrupted' },
    ]),
  );
  assert.equal(view.turns[0]?.userText, 'prompt');
  assert.equal(view.turns[0]?.text, 'Previous turn was interrupted');
  assert.equal(view.turns[0]?.status, 'completed');
});
