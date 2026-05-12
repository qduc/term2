import test from 'ava';
import { buildMessagesFromRequest } from './openai-compatible-messages.js';

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
