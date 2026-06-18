import { describe, it, expect } from 'vitest';
import { conversationUIReducer, createInitialUIState } from './conversation-ui-reducer.js';
import type { ApprovalDescriptor } from '../contracts/conversation.js';

describe('conversationUIReducer - multi-select bug fix', () => {
  it('should handle ask_user with two questions: single-select then multi-select', () => {
    const approval: ApprovalDescriptor = {
      agentName: 'Agent',
      toolName: 'ask_user',
      argumentsText: JSON.stringify({
        questions: [
          {
            question: 'First question (single-select)',
            options: ['Option A', 'Option B'],
            is_multi_select: false,
          },
          {
            question: 'Second question (multi-select)',
            options: ['Tool X', 'Tool Y', 'Tool Z'],
            is_multi_select: true,
          },
        ],
      }),
      rawInterruption: { type: 'ask_user' },
    };

    let state = createInitialUIState(null);

    // Initial approval request
    state = conversationUIReducer(state, {
      type: 'approval/requested',
      approval,
    });

    expect(state.waitingForApproval).toBe(true);
    expect(state.currentAskUserQuestionIndex).toBe(0);
    expect(state.askUserAnswers).toEqual([]);

    // Answer first question (single-select)
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: 'Option A',
    });

    expect(state.askUserAnswers).toEqual(['Option A']);

    // Advance to second question
    state = conversationUIReducer(state, {
      type: 'ask_user/advance_to_next',
      nextIndex: 1,
    });

    expect(state.currentAskUserQuestionIndex).toBe(1);

    // Answer second question (multi-select)
    // The reducer should store the array as-is, not as a JSON string
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: ['Tool X', 'Tool Z'],
    });

    // BUG FIX VERIFICATION:
    // Before the fix, the answer would be stored as '["Tool X","Tool Z"]' (string)
    // After the fix, it should be stored as ['Tool X', 'Tool Z'] (array)
    expect(state.askUserAnswers).toHaveLength(2);
    expect(state.askUserAnswers[0]).toBe('Option A');
    expect(Array.isArray(state.askUserAnswers[1])).toBe(true);
    expect(state.askUserAnswers[1]).toEqual(['Tool X', 'Tool Z']);
  });

  it('should handle three questions with mixed select types: single -> multi -> single', () => {
    const approval: ApprovalDescriptor = {
      agentName: 'Agent',
      toolName: 'ask_user',
      argumentsText: JSON.stringify({
        questions: [
          {
            question: 'First (single)',
            options: ['A', 'B'],
            is_multi_select: false,
          },
          {
            question: 'Second (multi)',
            options: ['X', 'Y', 'Z'],
            is_multi_select: true,
          },
          {
            question: 'Third (single)',
            options: ['P', 'Q'],
            is_multi_select: false,
          },
        ],
      }),
      rawInterruption: { type: 'ask_user' },
    };

    let state = createInitialUIState(null);

    // Initial approval request
    state = conversationUIReducer(state, {
      type: 'approval/requested',
      approval,
    });

    // Answer Q1: single-select
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: 'B',
    });
    state = conversationUIReducer(state, {
      type: 'ask_user/advance_to_next',
      nextIndex: 1,
    });

    expect(state.askUserAnswers).toEqual(['B']);
    expect(state.currentAskUserQuestionIndex).toBe(1);

    // Answer Q2: multi-select
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: ['X', 'Z'],
    });
    state = conversationUIReducer(state, {
      type: 'ask_user/advance_to_next',
      nextIndex: 2,
    });

    expect(state.askUserAnswers).toEqual(['B', ['X', 'Z']]);
    expect(state.currentAskUserQuestionIndex).toBe(2);

    // Answer Q3: single-select
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: 'Q',
    });

    expect(state.askUserAnswers).toEqual(['B', ['X', 'Z'], 'Q']);
  });

  it('should correctly identify which question is current based on askUserAnswers length', () => {
    const approval: ApprovalDescriptor = {
      agentName: 'Agent',
      toolName: 'ask_user',
      argumentsText: JSON.stringify({
        questions: [
          {
            question: 'Q1 (single)',
            options: ['A', 'B'],
            is_multi_select: false,
          },
          {
            question: 'Q2 (multi)',
            options: ['X', 'Y'],
            is_multi_select: true,
          },
        ],
      }),
      rawInterruption: { type: 'ask_user' },
    };

    let state = createInitialUIState(null);

    state = conversationUIReducer(state, {
      type: 'approval/requested',
      approval,
    });

    // When askUserAnswers.length is 0, we're on question 0 (single-select)
    expect(state.askUserAnswers.length).toBe(0);

    // Answer Q1
    state = conversationUIReducer(state, {
      type: 'ask_user/answer_submitted',
      answer: 'A',
    });
    state = conversationUIReducer(state, {
      type: 'ask_user/advance_to_next',
      nextIndex: 1,
    });

    // When askUserAnswers.length is 1, we're on question 1 (multi-select)
    expect(state.askUserAnswers.length).toBe(1);
    expect(state.currentAskUserQuestionIndex).toBe(1);
  });
});
