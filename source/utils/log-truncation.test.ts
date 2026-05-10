import test from 'ava';
import { sanitizeLogMetadata } from './log-truncation.js';

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
