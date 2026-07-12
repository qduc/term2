import { it, expect, vi } from 'vitest';
import { applyClientResponseNormalization } from './openai-compatible-response-normalizer.js';

const realUsageChunk = {
  id: 'r1',
  choices: [{ index: 0, delta: { content: 'hi' } }],
  usage: {
    prompt_tokens: 90,
    completion_tokens: 54,
    total_tokens: 144,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 52 },
  },
};

const costChunk = {
  choices: [],
  'x-opencode-type': 'inference-cost',
  cost: '0.00002772',
  normalizedUsage: {
    inputTokens: 90,
    outputTokens: 54,
    reasoningTokens: 52,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  },
};

function makeMockOpenAI(chunks: any[]) {
  return {
    chat: {
      completions: {
        create: async () => {
          return (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
      },
    },
  } as any;
}

async function collectStream(client: any): Promise<any[]> {
  const stream = await client.chat.completions.create();
  const chunks: any[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

const mockLoggingService = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  security: vi.fn(),
  setCorrelationId: vi.fn(),
  getCorrelationId: vi.fn(),
  clearCorrelationId: vi.fn(),
};

it('cost trailer is stripped from the stream', async () => {
  const client = makeMockOpenAI([realUsageChunk, costChunk]);
  applyClientResponseNormalization(client, mockLoggingService as any);

  const chunks = await collectStream(client);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].id).toBe('r1');
  expect(chunks[0].choices[0].delta.content).toBe('hi');
  expect(chunks[0].usage.prompt_tokens).toBe(90);
});

it('real usage chunk passes through with reasoning_content normalized', async () => {
  const reasoningChunk = {
    id: 'r2',
    choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
  const client = makeMockOpenAI([reasoningChunk, costChunk]);
  applyClientResponseNormalization(client, mockLoggingService as any);

  const chunks = await collectStream(client);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].choices[0].delta.reasoning).toBe('thinking...');
  expect(chunks[0].choices[0].delta.reasoning_content).toBe('thinking...');
});

it('non-streaming JSON response passes through unchanged', async () => {
  const jsonResponse = {
    id: 'r3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const client = {
    chat: {
      completions: {
        create: async () => jsonResponse,
      },
    },
  } as any;

  applyClientResponseNormalization(client, mockLoggingService as any);
  const result = await client.chat.completions.create();
  expect(result.choices[0].message.content).toBe('hello');
  expect(result.usage.prompt_tokens).toBe(10);
});

it('chunk with empty choices BUT a usage field is NOT stripped', async () => {
  const usageChunk = {
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const client = makeMockOpenAI([usageChunk]);
  applyClientResponseNormalization(client, mockLoggingService as any);

  const chunks = await collectStream(client);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].usage.prompt_tokens).toBe(10);
});

it('chunk with empty choices and no cost marker and no usage passes through', async () => {
  const emptyChunk = { choices: [] };
  const client = makeMockOpenAI([emptyChunk]);
  applyClientResponseNormalization(client, mockLoggingService as any);

  const chunks = await collectStream(client);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].choices).toEqual([]);
});
