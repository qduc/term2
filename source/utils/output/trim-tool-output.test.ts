import { it, expect } from 'vitest';
import { trimToolOutput } from './trim-tool-output.js';

it('trimToolOutput trims plain string output by characters', () => {
  const output = 'a'.repeat(200);
  const result = trimToolOutput(output, undefined, 50) as string;

  expect(result.includes('characters trimmed')).toBe(true);
  expect(result.length < output.length).toBe(true);
});

it('trimToolOutput trims string fields inside JSON output', () => {
  const payload = JSON.stringify({
    output: 'b'.repeat(200),
    other: 'ok',
  });

  const result = trimToolOutput(payload, undefined, 50) as string;
  const parsed = JSON.parse(result);

  expect(parsed.output.includes('characters trimmed')).toBe(true);
  expect(parsed.other).toBe('ok');
});

it('trimToolOutput trims nested JSON output arrays', () => {
  const payload = JSON.stringify({
    output: [
      {
        success: true,
        message: 'c'.repeat(200),
      },
    ],
  });

  const result = trimToolOutput(payload, undefined, 50) as string;
  const parsed = JSON.parse(result);

  expect(parsed.output[0].message.includes('characters trimmed')).toBe(true);
});

it('trimToolOutput preserves structured content-part arrays instead of coercing to a string', () => {
  // read_file returns a multimodal content-part array for images. Coercing it
  // via String() flattens it to "[object Object],[object Object]" and destroys
  // the image part before it reaches the provider converter. Trimming it would
  // truncate the base64 data and corrupt the image.
  const longData = Buffer.from('x'.repeat(10_000)).toString('base64');
  const parts = [
    { type: 'text', text: 'Image: logo.png (1234 bytes, image/png)' },
    { type: 'image', image: { data: longData, mediaType: 'image/png' } },
  ];

  const result = trimToolOutput(parts, undefined, 50);

  expect(Array.isArray(result)).toBe(true);
  expect(result).toEqual(parts);
});

it('trimToolOutput coerces a non-content-part array so it cannot escape the size limit', () => {
  // Only arrays that look like content parts (objects with a string `type`)
  // are multimodal results. Any other array keeps the old String() coercion:
  // exempting it would both skip trimming and hand the provider converters a
  // shape they reject.
  const result = trimToolOutput([{ value: 1 }, 'plain'], undefined, 50);

  expect(typeof result).toBe('string');
});

it('trimToolOutput coerces an empty array rather than treating it as content parts', () => {
  expect(trimToolOutput([], undefined, 50)).toBe('');
});
