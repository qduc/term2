import test from 'ava';
import { extractReasoningDelta, extractTextDelta } from './stream-event-parsing.js';

test('extractTextDelta: returns delta string for output_text events', (t) => {
  const payload = {
    type: 'response.output_text.delta',
    delta: 'Hello',
  };

  t.is(extractTextDelta(payload), 'Hello');
});

test('extractTextDelta: joins array output_text entries', (t) => {
  const payload = {
    type: 'response.output_text.delta',
    output_text: [{ text: 'Hello' }, { text: ' world' }],
  };

  t.is(extractTextDelta(payload), 'Hello world');
});

test('extractReasoningDelta: extracts OpenAI reasoning summary deltas', (t) => {
  const event = {
    data: {
      type: 'model',
      event: {
        type: 'response.reasoning_summary_text.delta',
        delta: 'think',
      },
    },
  };

  t.is(extractReasoningDelta(event), 'think');
});

test('extractReasoningDelta: extracts OpenRouter reasoning delta fields', (t) => {
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

  t.is(extractReasoningDelta(reasoningEvent), 'plan');
  t.is(extractReasoningDelta(reasoningContentEvent), 'execute');
});
