import test from 'ava';
import { buildMessagesFromRequest, addCacheControlToLastTwoMessages } from './openai-compatible-messages.js';

test('buildMessagesFromRequest() preserves user text and image content', (t) => {
  const messages = buildMessagesFromRequest({
    input: [
      {
        role: 'user',
        type: 'message',
        content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image: 'data:image/png;base64,abc123', detail: 'auto' },
        ],
      },
    ],
  } as any);

  t.deepEqual(messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ],
    },
  ]);
});

test('buildMessagesFromRequest() extracts text from assistant content blocks with type=text (Responses API shape)', (t) => {
  const messages = buildMessagesFromRequest({
    input: [
      {
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: 'Hi! How can I help?', annotations: [] }],
      },
    ],
  } as any);

  t.deepEqual(messages, [{ role: 'assistant', content: 'Hi! How can I help?' }]);
});

test('buildMessagesFromRequest() concatenates mixed output_text and text content blocks', (t) => {
  const messages = buildMessagesFromRequest({
    input: [
      {
        role: 'assistant',
        type: 'message',
        content: [
          { type: 'output_text', text: 'Part one.' },
          { type: 'text', text: ' Part two.', annotations: [] },
        ],
      },
    ],
  } as any);

  t.deepEqual(messages, [{ role: 'assistant', content: 'Part one. Part two.' }]);
});

test('addCacheControlToLastTwoMessages() adds cache control to system, last user, and last tool messages', (t) => {
  const messages = [
    { role: 'system', content: 'sys1' },
    { role: 'user', content: 'user1' },
    { role: 'tool', content: 'tool1' },
    { role: 'user', content: 'user2' },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.deepEqual(messages[0].content, [{ type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } }]);
  t.deepEqual(messages[1].content, 'user1'); // not last user
  t.deepEqual(messages[2].content, [{ type: 'text', text: 'tool1', cache_control: { type: 'ephemeral' } }]); // last tool
  t.deepEqual(messages[3].content, [{ type: 'text', text: 'user2', cache_control: { type: 'ephemeral' } }]); // last user
});

test('addCacheControlToLastTwoMessages() marks only the last system message when several exist', (t) => {
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
  t.is(messages[0].content, 'system prompt');
  t.is(messages[3].content, 'Plan Mode ON');
  t.deepEqual(messages[6].content, [{ type: 'text', text: 'Plan Mode OFF', cache_control: { type: 'ephemeral' } }]);

  // Plus the rolling last-user breakpoint. Total breakpoints stay within the
  // provider cap regardless of how many mode notices accumulate.
  t.deepEqual(messages[7].content, [{ type: 'text', text: 'u3', cache_control: { type: 'ephemeral' } }]);
  const breakpoints = messages.filter(
    (m) => Array.isArray(m.content) && m.content.some((c: any) => c.cache_control),
  ).length;
  t.is(breakpoints, 2);
});

test('addCacheControlToLastTwoMessages() adds cache_control to last text block in array content', (t) => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'world' }] },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.deepEqual(messages[0].content, [{ type: 'text', text: 'hello' }]); // not last user
  t.deepEqual(messages[1].content, [{ type: 'text', text: 'world', cache_control: { type: 'ephemeral' } }]); // last user
});

test('addCacheControlToLastTwoMessages() leaves other messages untouched', (t) => {
  const messages = [
    { role: 'user', content: 'untouched' },
    { role: 'user', content: 'untouched2' },
    { role: 'assistant', content: 'assistant' },
    { role: 'user', content: 'marked' },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.is(messages[0].content, 'untouched');
  t.is(messages[1].content, 'untouched2');
  t.is(messages[2].content, 'assistant');
  t.deepEqual(messages[3].content, [{ type: 'text', text: 'marked', cache_control: { type: 'ephemeral' } }]);
});

test('addCacheControlToLastTwoMessages() does nothing on empty array', (t) => {
  const messages: any[] = [];
  t.notThrows(() => addCacheControlToLastTwoMessages(messages));
  t.deepEqual(messages, []);
});

test('addCacheControlToLastTwoMessages() skips messages with no text content block', (t) => {
  const messages = [
    { role: 'tool', content: [{ type: 'image', data: 'abc' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.deepEqual(messages[0].content, [{ type: 'image', data: 'abc' }]);
  t.deepEqual(messages[1].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
});

test('buildMessagesFromRequest() preserves assistant messages that only carry reasoning metadata', (t) => {
  const messages = buildMessagesFromRequest({
    input: [
      { role: 'user', type: 'message', content: 'read package json' },
      {
        role: 'assistant',
        type: 'message',
        content: [],
        reasoning_content: 'I should inspect the file.',
      },
      { role: 'user', type: 'message', content: 'retry after failed hallucinated tool call' },
    ],
  } as any);

  t.deepEqual(messages, [
    { role: 'user', content: 'read package json' },
    {
      role: 'assistant',
      reasoning_content: 'I should inspect the file.',
    },
    { role: 'user', content: 'retry after failed hallucinated tool call' },
  ]);
});

test('addCacheControlToLastTwoMessages() filters by modelId correctly', (t) => {
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
      t.deepEqual(messages[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
      t.deepEqual(messages[1].content, 'world'); // assistant does not get cache control under new rules
    } else {
      t.deepEqual(messages[0].content, 'hello');
      t.deepEqual(messages[1].content, 'world');
    }
  }
});

test('buildMessagesFromRequest() adds cache control for Qwen models', (t) => {
  const messages = buildMessagesFromRequest(
    {
      input: [
        { role: 'user', type: 'message', content: 'hello' },
        {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    } as any,
    'qwen/qwen-2.5-coder',
  );

  t.deepEqual(messages[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
  t.is(messages[1].content, 'hi');
});
