import { describe, expect, it } from 'vitest';
import { FROZEN_AGENT_EVENT_TYPES } from '../../../source/gateway/persistence/contracts.js';
import { AGENT_EVENT_TYPES, validatePendingInteractionDto } from './index.js';

describe('agent wire event contract', () => {
  it('exports the current frozen event-type set', () => {
    expect(new Set(AGENT_EVENT_TYPES)).toEqual(new Set(FROZEN_AGENT_EVENT_TYPES));
  });
});

describe('ask_user option limits', () => {
  const dto = (optionCount: number) => ({
    version: 1 as const,
    interactionId: 'interaction-1',
    kind: 'ask_user' as const,
    variant: 'ask_user' as const,
    descriptor: { agentName: 'agent', toolName: 'ask_user', argumentsText: '{}' },
    choices: [{ id: 'approve', label: 'Approve' }],
    askUser: {
      questions: [
        {
          index: 0,
          question: 'Pick one',
          options: Array.from({ length: optionCount }, (_, index) => ({ label: `Option ${index}` })),
          multiSelect: false,
        },
      ],
      answers: [],
      currentQuestionIndex: 0,
    },
    revision: 1,
  });

  it('accepts 32 options', () => {
    expect(validatePendingInteractionDto(dto(32))).toBeDefined();
  });

  it('rejects 33 options', () => {
    expect(() => validatePendingInteractionDto(dto(33))).toThrow();
  });
});
