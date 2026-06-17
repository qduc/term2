import { it, expect } from 'vitest';
import { z } from 'zod';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';

it('toOpenAIStrictToolSchema converts optional fields to nullable default null', () => {
  const schema = z.object({
    command: z.string(),
    timeout_ms: z.number().int().positive().optional().describe('timeout'),
  });

  const transformed = toOpenAIStrictToolSchema(schema);
  const parsed = transformed.safeParse({ command: 'echo hi' });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect((parsed.data as any).timeout_ms).toBe(null);
  }

  expect(transformed.safeParse({ command: 'echo hi', timeout_ms: null }).success).toBe(true);
  expect(transformed.safeParse({ command: 'echo hi', timeout_ms: 1000 }).success).toBe(true);
});

it('toOpenAIStrictToolSchema leaves schema unchanged when there are no optional fields', () => {
  const schema = z.object({
    command: z.string(),
  });

  const transformed = toOpenAIStrictToolSchema(schema);
  expect(transformed).toBe(schema);
  expect(transformed.safeParse({ command: 'echo hi' }).success).toBe(true);
});
