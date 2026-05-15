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

test('addCacheControlToLastTwoMessages() converts string content to array with cache_control on last 2 messages', (t) => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.deepEqual(messages[0].content, 'first');
  t.deepEqual(messages[1].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
  t.deepEqual(messages[2].content, [{ type: 'text', text: 'third', cache_control: { type: 'ephemeral' } }]);
});

test('addCacheControlToLastTwoMessages() adds cache_control to last text block in array content', (t) => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'world' }] },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.deepEqual(messages[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
  t.deepEqual(messages[1].content, [{ type: 'text', text: 'world', cache_control: { type: 'ephemeral' } }]);
});

test('addCacheControlToLastTwoMessages() leaves earlier messages untouched', (t) => {
  const messages = [
    { role: 'user', content: 'untouched' },
    { role: 'user', content: 'untouched2' },
    { role: 'assistant', content: 'marked1' },
    { role: 'user', content: 'marked2' },
  ];
  addCacheControlToLastTwoMessages(messages);
  t.is(messages[0].content, 'untouched');
  t.is(messages[1].content, 'untouched2');
  t.deepEqual(messages[2].content, [{ type: 'text', text: 'marked1', cache_control: { type: 'ephemeral' } }]);
  t.deepEqual(messages[3].content, [{ type: 'text', text: 'marked2', cache_control: { type: 'ephemeral' } }]);
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

test('buildMessagesFromRequest() omits assistant messages without content or tool calls', (t) => {
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
    { role: 'user', content: 'retry after failed hallucinated tool call' },
  ]);
});
