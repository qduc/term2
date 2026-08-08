import { describe, expect, it } from 'vitest';
import { ASK_USER_DECLINE_RESULT } from '../../tools/agent/ask-user-constants.js';
import { PendingInteractionState } from './pending-interaction-state.js';

const askUserApproval = {
  agentName: 'Agent',
  toolName: 'ask_user',
  argumentsText: JSON.stringify({
    questions: [
      { question: 'First?', is_multi_select: false },
      { question: 'Second?', is_multi_select: true },
    ],
  }),
  rawInterruption: null,
  callId: 'ask-1',
};

describe('PendingInteractionState', () => {
  it('owns ask_user answers and exposes an immutable snapshot', () => {
    const state = new PendingInteractionState();
    state.present(askUserApproval);

    const first = state.resolve({ answer: 'y', approvalAnswer: 'one' });
    expect(first).toMatchObject({ kind: 'awaiting_next_question' });
    expect(state.getSnapshot()).toMatchObject({
      interactionId: 1,
      approval: askUserApproval,
      askUserAnswers: ['one'],
      currentAskUserQuestionIndex: 1,
    });

    const final = state.resolve({ answer: 'y', approvalAnswer: JSON.stringify(['two', 'three']) });
    expect(final).toMatchObject({
      kind: 'resolved',
      interactionId: 1,
      approvalAnswer: JSON.stringify(['one', ['two', 'three']]),
    });
    expect(state.getSnapshot()).toBeNull();
  });

  it('preserves the existing forward-navigation behavior until it is deliberately changed', () => {
    const state = new PendingInteractionState();
    state.present(askUserApproval);

    state.goToNextQuestion();

    expect(state.getSnapshot()).toMatchObject({
      askUserAnswers: [],
      currentAskUserQuestionIndex: 1,
    });
  });

  it('resolves a declined ask_user answer without recording an answer', () => {
    const state = new PendingInteractionState();
    state.present(askUserApproval);

    expect(state.resolve({ answer: 'y', approvalAnswer: ASK_USER_DECLINE_RESULT })).toMatchObject({
      kind: 'resolved',
      approvalAnswer: ASK_USER_DECLINE_RESULT,
    });
    expect(state.getSnapshot()).toBeNull();
  });
});
