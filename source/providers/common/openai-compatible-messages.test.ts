import { it, expect } from 'vitest';
import { addCacheControlToLastTwoMessages } from './openai-compatible-messages.js';

it('addCacheControlToLastTwoMessages() adds cache control to system, last user, and last tool messages', () => {
  const messages = [
    { role: 'system', content: 'sys1' },
    { role: 'user', content: 'user1' },
    { role: 'tool', content: 'tool1' },
    { role: 'user', content: 'user2' },
  ];
  addCacheControlToLastTwoMessages(messages);
  expect(messages[0].content).toEqual([{ type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } }]);
  expect(messages[1].content).toEqual('user1'); // not last user
  expect(messages[2].content).toEqual([{ type: 'text', text: 'tool1', cache_control: { type: 'ephemeral' } }]); // last tool
  expect(messages[3].content).toEqual([{ type: 'text', text: 'user2', cache_control: { type: 'ephemeral' } }]); // last user
});

it('addCacheControlToLastTwoMessages() marks only the last system message when several exist', () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'system', content: 'Plan Mode ON' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'system', content: 'Plan Mode OFF' },
    { role: 'user', content: 'u3' },
  ];
  addCacheControlToLastTwoMessages(messages);

  // Only the last system message carries a breakpoint (not every one).
  expect(messages[0].content).toBe('system prompt');
  expect(messages[3].content).toBe('Plan Mode ON');
  expect(messages[6].content).toEqual([{ type: 'text', text: 'Plan Mode OFF', cache_control: { type: 'ephemeral' } }]);

  // Plus the rolling last-user breakpoint. Total breakpoints stay within the
  // provider cap regardless of how many mode notices accumulate.
  expect(messages[7].content).toEqual([{ type: 'text', text: 'u3', cache_control: { type: 'ephemeral' } }]);
  const breakpoints = messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((c: any) => c.cache_control),
  ).length;
  expect(breakpoints).toBe(2);
});

it('addCacheControlToLastTwoMessages() adds cache_control to last text block in array content', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'world' }] },
  ];
  addCacheControlToLastTwoMessages(messages);
  expect(messages[0].content).toEqual([{ type: 'text', text: 'hello' }]); // not last user
  expect(messages[1].content).toEqual([{ type: 'text', text: 'world', cache_control: { type: 'ephemeral' } }]); // last user
});

it('addCacheControlToLastTwoMessages() leaves other messages untouched', () => {
  const messages = [
    { role: 'user', content: 'untouched' },
    { role: 'user', content: 'untouched2' },
    { role: 'assistant', content: 'assistant' },
    { role: 'user', content: 'marked' },
  ];
  addCacheControlToLastTwoMessages(messages);
  expect(messages[0].content).toBe('untouched');
  expect(messages[1].content).toBe('untouched2');
  expect(messages[2].content).toBe('assistant');
  expect(messages[3].content).toEqual([{ type: 'text', text: 'marked', cache_control: { type: 'ephemeral' } }]);
});

it('addCacheControlToLastTwoMessages() does nothing on empty array', () => {
  const messages: any[] = [];
  expect(() => addCacheControlToLastTwoMessages(messages)).not.toThrow();
  expect(messages).toEqual([]);
});

it('addCacheControlToLastTwoMessages() skips messages with no text content block', () => {
  const messages = [
    { role: 'tool', content: [{ type: 'image', data: 'abc' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  addCacheControlToLastTwoMessages(messages);
  expect(messages[0].content).toEqual([{ type: 'image', data: 'abc' }]);
  expect(messages[1].content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
});

it('addCacheControlToLastTwoMessages() filters by modelId correctly', () => {
  const testCases = [
    { modelId: 'anthropic/claude-3-5-sonnet', shouldCache: true },
    { modelId: 'claude-3-5-haiku', shouldCache: true },
    { modelId: 'qwen/qwen-2.5-coder-32b', shouldCache: true },
    { modelId: 'gpt-4o', shouldCache: false },
    { modelId: 'meta-llama/llama-3.1-405b', shouldCache: false },
    { modelId: 'gemini-1.5-pro', shouldCache: false },
  ];

  for (const { modelId, shouldCache } of testCases) {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    addCacheControlToLastTwoMessages(messages, modelId);
    if (shouldCache) {
      expect(messages[0].content).toEqual([{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
      expect(messages[1].content).toEqual('world'); // assistant does not get cache control under new rules
    } else {
      expect(messages[0].content).toEqual('hello');
      expect(messages[1].content).toEqual('world');
    }
  }
});
