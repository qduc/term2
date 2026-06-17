import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sanitizeLogMetadata, truncateLogText } from './log-truncation.js';
import type { LogMetadata, ImageContentPart } from './log-truncation.js';

it('sanitizeLogMetadata truncates image payloads in messages content', () => {
  const longBase64 = 'data:image/png;base64,' + 'a'.repeat(10000);
  const meta: LogMetadata = {
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
  const firstMessage = sanitized.messages![0]!;
  const content = firstMessage.content as ImageContentPart[];
  const directImage = content[1].image!;
  const imageUrl = content[2].image_url!.url!;

  expect(sanitized).not.toBe(meta);
  expect(directImage.length < 500).toBe(true);
  expect(directImage.endsWith('... (truncated)')).toBe(true);
  expect(imageUrl.length < 500).toBe(true);
  expect(imageUrl.endsWith('... (truncated)')).toBe(true);
  expect((meta.messages![0]!.content as ImageContentPart[])[1].image).toBe(longBase64);
  expect((meta.messages![0]!.content as ImageContentPart[])[2].image_url!.url).toBe(longBase64);
});

it('sanitizeLogMetadata returns metadata unchanged when there are no truncation targets', () => {
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

  expect(sanitized).toBe(meta);
});

it('sanitizeLogMetadata truncates long system prompt content', () => {
  const longSystemPrompt = 'You are a helpful assistant. '.repeat(50);
  expect(longSystemPrompt.length > 500).toBe(true);

  const meta = {
    eventType: 'provider.request.started',
    messages: [
      { role: 'system', content: longSystemPrompt },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  };

  const sanitized = sanitizeLogMetadata(meta);
  const systemMsg = sanitized.messages![0]!;

  expect(sanitized).not.toBe(meta);
  expect(typeof systemMsg.content === 'string').toBe(true);
  expect((systemMsg.content as string).length < 700).toBe(true);
  expect((systemMsg.content as string).includes('... (truncated')).toBe(true);
});

it('sanitizeLogMetadata truncates developer role content', () => {
  const longDevPrompt = 'You are Claude. '.repeat(50);
  expect(longDevPrompt.length > 500).toBe(true);

  const meta = {
    messages: [{ role: 'developer', content: longDevPrompt }],
  };

  const sanitized = sanitizeLogMetadata(meta);
  expect(sanitized).not.toBe(meta);
  expect((sanitized.messages![0]!.content as string).includes('... (truncated')).toBe(true);
});

it('sanitizeLogMetadata does not truncate short system prompt', () => {
  const shortSystem = 'You are helpful.';

  const meta = {
    messages: [{ role: 'system', content: shortSystem }],
  };

  expect(sanitizeLogMetadata(meta)).toBe(meta);
});

it('sanitizeLogMetadata truncates long tool descriptions', () => {
  const longDesc = 'This tool does something very important. '.repeat(30);
  expect(longDesc.length > 200).toBe(true);

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
  const desc = sanitized.tools![0]!.function!.description!;

  expect(sanitized).not.toBe(meta);
  expect(desc.length < 500).toBe(true);
  expect(desc.includes('... (truncated')).toBe(true);
});

it('sanitizeLogMetadata does not truncate short tool description', () => {
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

  expect(sanitizeLogMetadata(meta)).toBe(meta);
});

it('sanitizeLogMetadata handles both messages and tools together', () => {
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
  expect(sanitized).not.toBe(meta);
  expect((sanitized.messages![0]!.content as string).length < longSystem.length).toBe(true);
  expect(sanitized.tools![0]!.function!.description!.length < longDesc.length).toBe(true);
});

it('sanitizeLogMetadata returns original when tools array has no descriptions to truncate', () => {
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

  expect(sanitizeLogMetadata(meta)).toBe(meta);
});

it('sanitizeLogMetadata omits reasoning fields from assistant messages', () => {
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
  const msg = sanitized.messages![0]!;
  expect('reasoning' in msg).toBe(false);
  expect('reasoning_content' in msg).toBe(false);
  expect(msg.content).toEqual(meta.messages![0]!.content as ImageContentPart[]);
});

it('truncateLogText keeps the head and tail of long text', () => {
  const text = `HEAD-${'a'.repeat(2000)}-TAIL`;
  const truncated = truncateLogText(text, 1200);

  expect(truncated.startsWith('HEAD-')).toBe(true);
  expect(truncated.endsWith('-TAIL')).toBe(true);
  expect(truncated.includes('... (truncated,')).toBe(true);
  expect(truncated.length < text.length).toBe(true);
});
