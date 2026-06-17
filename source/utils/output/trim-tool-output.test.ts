import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { trimToolOutput } from './trim-tool-output.js';

it('trimToolOutput trims plain string output by characters', () => {
  const output = 'a'.repeat(200);
  const result = trimToolOutput(output, undefined, 50);

  expect(result.includes('characters trimmed')).toBe(true);
  expect(result.length < output.length).toBe(true);
});

it('trimToolOutput trims string fields inside JSON output', () => {
  const payload = JSON.stringify({
    output: 'b'.repeat(200),
    other: 'ok',
  });

  const result = trimToolOutput(payload, undefined, 50);
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

  const result = trimToolOutput(payload, undefined, 50);
  const parsed = JSON.parse(result);

  expect(parsed.output[0].message.includes('characters trimmed')).toBe(true);
});
