import { describe, expect, it } from 'vitest';
import {
  assertValidOpenAICompatibleMessages,
  hasOpenAICompatibleAssistantPayload,
} from './openai-compatible-message-contract.js';

describe('OpenAI-compatible assistant message contract', () => {
  it.each([
    { role: 'assistant', content: 'answer' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1' }] },
    { role: 'user', content: 'question' },
    { role: 'tool', content: 'result' },
  ])('accepts a message with a provider-valid payload: %j', (message) => {
    expect(hasOpenAICompatibleAssistantPayload(message)).toBe(true);
    expect(() => assertValidOpenAICompatibleMessages([message])).not.toThrow();
  });

  it.each([
    { role: 'assistant' },
    { role: 'assistant', content: null },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'assistant', content: null, reasoning_content: 'metadata is not a message payload' },
    { role: 'assistant', content: null, reasoning_details: [{ type: 'thinking', text: 'metadata' }] },
  ])('rejects an assistant message without content or tool calls: %j', (message) => {
    expect(hasOpenAICompatibleAssistantPayload(message)).toBe(false);
    expect(() => assertValidOpenAICompatibleMessages([message])).toThrow(
      'Invalid OpenAI-compatible assistant message at index 0: content or tool_calls must be set',
    );
  });
});
