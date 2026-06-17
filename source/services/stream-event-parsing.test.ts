import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { extractReasoningDelta, extractTextDelta } from './stream-event-parsing.js';

it('extractTextDelta: returns delta string for output_text events', () => {
  const payload = {
    type: 'response.output_text.delta',
    delta: 'Hello',
  };

  expect(extractTextDelta(payload)).toBe('Hello');
});

it('extractTextDelta: joins array output_text entries', () => {
  const payload = {
    type: 'response.output_text.delta',
    output_text: [{ text: 'Hello' }, { text: ' world' }],
  };

  expect(extractTextDelta(payload)).toBe('Hello world');
});

it('extractTextDelta: ignores done events', () => {
  const payload = {
    type: 'response.output_text.done',
    text: 'Hello world',
  };

  expect(extractTextDelta(payload)).toBe(null);
});

it('extractReasoningDelta: extracts OpenAI reasoning summary deltas', () => {
  const event = {
    data: {
      type: 'model',
      event: {
        type: 'response.reasoning_summary_text.delta',
        delta: 'think',
      },
    },
  };

  expect(extractReasoningDelta(event)).toBe('think');
});

it('extractReasoningDelta: extracts model reasoning-delta events', () => {
  const event = {
    data: {
      type: 'model',
      event: {
        type: 'reasoning-delta',
        delta: 'The',
        id: 'msfDurU72uN4YQQg',
      },
    },
  };

  expect(extractReasoningDelta(event)).toBe('The');
});

it('extractReasoningDelta: extracts OpenRouter reasoning delta fields', () => {
  const reasoningEvent = {
    data: {
      event: {
        choices: [
          {
            delta: {
              reasoning: 'plan',
            },
          },
        ],
      },
    },
  };

  const reasoningContentEvent = {
    data: {
      event: {
        choices: [
          {
            delta: {
              reasoning_content: 'execute',
            },
          },
        ],
      },
    },
  };

  expect(extractReasoningDelta(reasoningEvent)).toBe('plan');
  expect(extractReasoningDelta(reasoningContentEvent)).toBe('execute');
});
