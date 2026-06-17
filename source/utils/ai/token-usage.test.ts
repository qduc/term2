import { it, expect } from 'vitest';
import {
  addBillableSessionTokenUsage,
  addTokenUsage,
  createUsageAccumulator,
  extractUsage,
  formatFooterUsage,
  formatSessionTokenUsage,
  formatSessionUsageBreakdown,
  normalizeAgentRunUsage,
  normalizeUsage,
} from './token-usage.js';

it('normalizeUsage handles multiple formats', () => {
  // OpenAI style
  expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toEqual({
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  });

  // OpenAI prompt token details style
  expect(
    normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } }),
  ).toEqual({
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    cache_read_tokens: 4,
  });

  // Anthropic style
  expect(
    normalizeUsage({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 12,
    }),
  ).toEqual({
    prompt_tokens: 100,
    completion_tokens: 25,
    total_tokens: 137,
    cache_read_tokens: 60,
    cache_creation_tokens: 12,
  });

  // Agents SDK style
  expect(normalizeUsage({ inputTokens: 5, outputTokens: 15, totalTokens: 20 })).toEqual({
    prompt_tokens: 5,
    completion_tokens: 15,
    total_tokens: 20,
  });

  // Mixed/partial
  expect(normalizeUsage({ input_tokens: 100 })).toEqual({
    prompt_tokens: 100,
    total_tokens: 100,
  });
});

it('normalizeAgentRunUsage reads the SDK run-state accumulator and sums per-request detail arrays', () => {
  // Shape mirrors @openai/agents-core Usage: cumulative scalar totals plus
  // per-request detail arrays for cache/reasoning.
  expect(
    normalizeAgentRunUsage({
      requests: 3,
      inputTokens: 6000,
      outputTokens: 280,
      totalTokens: 6280,
      inputTokensDetails: [{ cached_tokens: 500 }, { cached_tokens: 1000 }, { cached_tokens: 0 }],
      outputTokensDetails: [{ reasoning_tokens: 40 }, { reasoning_tokens: 60 }, {}],
    }),
  ).toEqual({
    prompt_tokens: 6000,
    completion_tokens: 280,
    total_tokens: 6280,
    cache_read_tokens: 1500,
    reasoning_tokens: 100,
  });
});

it('normalizeAgentRunUsage treats an all-zero accumulator as absent', () => {
  expect(
    normalizeAgentRunUsage({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [],
      outputTokensDetails: [],
    }),
  ).toBe(undefined);
  expect(normalizeAgentRunUsage(undefined)).toBe(undefined);
  expect(normalizeAgentRunUsage(null)).toBe(undefined);
});

it('extractUsage finds usage in nested locations', () => {
  const payload = {
    usage: { prompt_tokens: 1, total_tokens: 3 },
    response: { usage: { completion_tokens: 2, total_tokens: 3 } },
  };
  expect(extractUsage(payload)).toEqual({
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
});

it('extractUsage preserves cache usage when merging normalized sources', () => {
  const payload = {
    usage: {
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 4 },
    },
    response: {
      usage: {
        completion_tokens: 2,
      },
    },
  };

  expect(extractUsage(payload)).toEqual({
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    cache_read_tokens: 4,
  });
});

it('extractUsage finds usage in raw model stream event payload shape', () => {
  const payload = {
    data: {
      type: 'model',
      event: {
        id: '8d03b4e8-46ab-45f7-aed4-670157c3dd6d',
        object: 'chat.completion.chunk',
        created: 1778912418,
        model: 'deepseek-v4-flash',
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      },
      providerData: {
        rawModelEventSource: 'openai-chat-completions',
      },
    },
    source: 'openai-chat-completions',
    type: 'raw_model_stream_event',
  };

  expect(extractUsage(payload)).toEqual({
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
  });
});

it('formatFooterUsage returns formatted string', () => {
  expect(formatFooterUsage({ prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 })).toBe(
    'Tok: 1,200 in / 350 out',
  );
  expect(
    formatFooterUsage({
      prompt_tokens: 1200,
      completion_tokens: 350,
      total_tokens: 1550,
      cache_read_tokens: 900,
      cache_creation_tokens: 120,
    }),
  ).toBe('Tok: 1,200 in (900 cached, 120 cache write) / 350 out');
  expect(formatFooterUsage({ prompt_tokens: 2054, completion_tokens: 74, cache_read_tokens: 1920 })).toBe(
    'Tok: 2,054 in (1,920 cached) / 74 out',
  );
  expect(formatFooterUsage({ cache_read_tokens: 42 })).toBe('');
  expect(formatFooterUsage({ total_tokens: 100 })).toBe('');
  expect(formatFooterUsage(null)).toBe('');
});

it('addTokenUsage accumulates usage counters', () => {
  expect(
    addTokenUsage(
      { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 800 },
      { prompt_tokens: 2000, completion_tokens: 300, cache_read_tokens: 1200, cache_creation_tokens: 50 },
    ),
  ).toEqual({
    prompt_tokens: 3000,
    completion_tokens: 500,
    cache_read_tokens: 2000,
    cache_creation_tokens: 50,
  });

  expect(addTokenUsage(undefined, undefined)).toEqual({});
});

it('addBillableSessionTokenUsage subtracts cached input before accumulating prompt tokens', () => {
  expect(
    addBillableSessionTokenUsage(
      { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 50 },
      { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 800 },
    ),
  ).toEqual({
    prompt_tokens: 300,
    completion_tokens: 220,
    cache_read_tokens: 850,
  });

  expect(addBillableSessionTokenUsage(undefined, { prompt_tokens: 100, cache_read_tokens: 150 })).toEqual({
    prompt_tokens: 0,
    cache_read_tokens: 150,
  });
});

it('createUsageAccumulator adds billable input and resets session usage', () => {
  const accumulator = createUsageAccumulator({ prompt_tokens: 10, completion_tokens: 2 });
  accumulator.add({ prompt_tokens: 5, completion_tokens: 3, cache_read_tokens: 4 });

  expect(accumulator.get()).toEqual({
    prompt_tokens: 11,
    completion_tokens: 5,
    cache_read_tokens: 4,
  });

  accumulator.reset();
  expect(accumulator.get()).toEqual({});
});

it('createUsageAccumulator subtracts cached input on every model turn', () => {
  const accumulator = createUsageAccumulator();

  accumulator.add({ prompt_tokens: 1000, completion_tokens: 100, cache_read_tokens: 800 });
  expect(accumulator.get()).toEqual({
    prompt_tokens: 200,
    completion_tokens: 100,
    cache_read_tokens: 800,
  });

  accumulator.add({ prompt_tokens: 1000, completion_tokens: 100, cache_read_tokens: 800 });
  expect(accumulator.get()).toEqual({
    prompt_tokens: 400,
    completion_tokens: 200,
    cache_read_tokens: 1600,
  });
});

it('createUsageAccumulator accumulates already billable input without subtracting cached tokens again', () => {
  const accumulator = createUsageAccumulator();

  accumulator.add({ prompt_tokens: 200, completion_tokens: 100, cache_read_tokens: 800 }, { alreadyBillable: true });
  expect(accumulator.get()).toEqual({
    prompt_tokens: 200,
    completion_tokens: 100,
    cache_read_tokens: 800,
  });

  accumulator.add({ prompt_tokens: 200, completion_tokens: 100, cache_read_tokens: 800 }, { alreadyBillable: true });
  expect(accumulator.get()).toEqual({
    prompt_tokens: 400,
    completion_tokens: 200,
    cache_read_tokens: 1600,
  });
});

it('formatSessionTokenUsage matches slash command output', () => {
  expect(
    formatSessionTokenUsage({
      prompt_tokens: 20000,
      completion_tokens: 20000,
      cache_read_tokens: 1000000,
      cache_creation_tokens: 500,
    }),
  ).toBe('Token usage: 20,000 input (1,000,000 cached), 20,000 output');

  expect(formatSessionTokenUsage({ prompt_tokens: 100, completion_tokens: 20 })).toBe(
    'Token usage: 100 input, 20 output',
  );
  expect(formatSessionTokenUsage(null)).toBe('Token usage: 0 input, 0 output');
});

it('formatSessionUsageBreakdown shows breakdown when subagent usage exists', () => {
  const main: any = { prompt_tokens: 6827, completion_tokens: 268, cache_read_tokens: 6656 };
  const sub: any = { prompt_tokens: 1000, completion_tokens: 50, cache_read_tokens: 500 };

  const result = formatSessionUsageBreakdown(main, sub);
  const lines = result.split('\n');

  expect(lines.length).toBe(3);
  expect(lines[0]).toBe('Main: 6,827 input (6,656 cached), 268 output');
  expect(lines[1]).toBe('Subagents: 1,000 input (500 cached), 50 output');
  expect(lines[2]).toBe('Total: 7,827 input (7,156 cached), 318 output');
});

it('formatSessionUsageBreakdown falls back to single line when no subagent usage', () => {
  const main: any = { prompt_tokens: 6827, completion_tokens: 268, cache_read_tokens: 6656 };

  expect(formatSessionUsageBreakdown(main, null)).toBe('Token usage: 6,827 input (6,656 cached), 268 output');
  expect(formatSessionUsageBreakdown(main, undefined)).toBe('Token usage: 6,827 input (6,656 cached), 268 output');
  expect(formatSessionUsageBreakdown(main, {})).toBe('Token usage: 6,827 input (6,656 cached), 268 output');
});

it('formatSessionUsageBreakdown single-line fallback when subagent usage is all zeros', () => {
  const main: any = { prompt_tokens: 100, completion_tokens: 20 };
  const sub: any = { prompt_tokens: 0, completion_tokens: 0 };

  expect(formatSessionUsageBreakdown(main, sub)).toBe('Token usage: 100 input, 20 output');
});

it('formatSessionUsageBreakdown always shows three lines when subagent has non-zero usage', () => {
  const main: any = { prompt_tokens: 100, completion_tokens: 20 };
  const sub: any = { prompt_tokens: 0, completion_tokens: 5 };

  const result = formatSessionUsageBreakdown(main, sub);
  const lines = result.split('\n');

  expect(lines.length).toBe(3);
  expect(lines[0]).toBe('Main: 100 input, 20 output');
  expect(lines[1]).toBe('Subagents: 0 input, 5 output');
  expect(lines[2]).toBe('Total: 100 input, 25 output');
});

it('extractUsage does NOT find usage from RunResult.state.usage shape', () => {
  // The SDK's RunResult stores usage in state.usage (Usage class with
  // inputTokens/outputTokens). extractUsage doesn't check state.usage,
  // so this should return undefined, confirming the bug.
  const runResult = {
    state: {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    },
    rawResponses: [],
    newItems: [],
  };

  expect(extractUsage(runResult), 'extractUsage should miss RunResult.state.usage').toBe(undefined);
});

it('normalizeAgentRunUsage extracts usage from SDK Usage shape with inputTokens/outputTokens', () => {
  // This is the fix path: normalizeAgentRunUsage understands the SDK's
  // Usage class shape and converts it to NormalizedUsage.
  const sdkUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };

  expect(normalizeAgentRunUsage(sdkUsage)).toEqual({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });
});
