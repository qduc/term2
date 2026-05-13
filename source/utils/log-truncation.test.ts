import test from 'ava';
import { sanitizeLogMetadata, truncateLogText } from './log-truncation.js';

test('sanitizeLogMetadata truncates image payloads in messages content', (t) => {
  const longBase64 = 'data:image/png;base64,' + 'a'.repeat(10000);
  const meta = {
    eventType: 'provider.request.started',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', image: longBase64 },
          { type: 'input_image', image_url: { url: longBase64, detail: 'high' } },
        ],
      },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  const firstMessage = sanitized.messages[0]!;
  const directImage = firstMessage.content[1].image;
  const imageUrl = firstMessage.content[2].image_url!.url;

  t.not(sanitized, meta);
  t.true(directImage.length < 500);
  t.true(directImage.endsWith('... (truncated)'));
  t.true(imageUrl.length < 500);
  t.true(imageUrl.endsWith('... (truncated)'));
  t.is(meta.messages[0]!.content[1].image, longBase64);
  t.is(meta.messages[0]!.content[2].image_url!.url, longBase64);
});

test('sanitizeLogMetadata returns metadata unchanged when there are no truncation targets', (t) => {
  const meta = {
    eventType: 'provider.request.started',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'plain text only' }],
      },
    ],
    provider: 'openai',
  };

  const sanitized = sanitizeLogMetadata(meta);

  t.is(sanitized, meta);
});

test('sanitizeLogMetadata truncates long system prompt content', (t) => {
  const longSystemPrompt = 'You are a helpful assistant. '.repeat(50);
  t.true(longSystemPrompt.length > 500);

  const meta = {
    eventType: 'provider.request.started',
    messages: [
      { role: 'system', content: longSystemPrompt },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  const systemMsg = sanitized.messages[0];

  t.not(sanitized, meta);
  t.true(typeof systemMsg.content === 'string');
  t.true(systemMsg.content.length < 700);
  t.true(systemMsg.content.includes('... (truncated'));
});

test('sanitizeLogMetadata truncates developer role content', (t) => {
  const longDevPrompt = 'You are Claude. '.repeat(50);
  t.true(longDevPrompt.length > 500);

  const meta = {
    messages: [{ role: 'developer', content: longDevPrompt }],
  };

  const sanitized = sanitizeLogMetadata(meta);
  t.not(sanitized, meta);
  t.true(sanitized.messages[0].content.includes('... (truncated'));
});

test('sanitizeLogMetadata does not truncate short system prompt', (t) => {
  const shortSystem = 'You are helpful.';

  const meta = {
    messages: [{ role: 'system', content: shortSystem }],
  };

  t.is(sanitizeLogMetadata(meta), meta);
});

test('sanitizeLogMetadata truncates long tool descriptions', (t) => {
  const longDesc = 'This tool does something very important. '.repeat(30);
  t.true(longDesc.length > 200);

  const meta = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'my_tool',
          description: longDesc,
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  const desc = sanitized.tools[0].function.description;

  t.not(sanitized, meta);
  t.true(desc.length < 500);
  t.true(desc.includes('... (truncated'));
});

test('sanitizeLogMetadata does not truncate short tool description', (t) => {
  const meta = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'my_tool',
          description: 'Short description',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  };

  t.is(sanitizeLogMetadata(meta), meta);
});

test('sanitizeLogMetadata handles both messages and tools together', (t) => {
  const longSystem = 'You are helpful. '.repeat(50);
  const longDesc = 'This does something. '.repeat(30);

  const meta = {
    messages: [{ role: 'system', content: longSystem }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'my_tool',
          description: longDesc,
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  t.not(sanitized, meta);
  t.true(sanitized.messages[0].content.length < longSystem.length);
  t.true(sanitized.tools[0].function.description.length < longDesc.length);
});

test('sanitizeLogMetadata returns original when tools array has no descriptions to truncate', (t) => {
  const meta = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'my_tool',
          parameters: { type: 'object' },
        },
      },
    ],
  };

  t.is(sanitizeLogMetadata(meta), meta);
});

test('sanitizeLogMetadata omits reasoning fields from assistant messages', (t) => {
  const meta = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        reasoning: 'some long reasoning text',
        reasoning_content: 'some long reasoning text',
      },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  const msg = sanitized.messages[0]!;
  t.false('reasoning' in msg);
  t.false('reasoning_content' in msg);
  t.deepEqual(msg.content, meta.messages[0]!.content);
});

test('truncateLogText keeps the head and tail of long text', (t) => {
  const text = `HEAD-${'a'.repeat(2000)}-TAIL`;
  const truncated = truncateLogText(text, 1200);

  t.true(truncated.startsWith('HEAD-'));
  t.true(truncated.endsWith('-TAIL'));
  t.true(truncated.includes('... (truncated,'));
  t.true(truncated.length < text.length);
});
