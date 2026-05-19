import test from 'ava';
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

test('normalizeUsage handles multiple formats', (t) => {
  // OpenAI style
  t.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }), {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  });

  // OpenAI prompt token details style
  t.deepEqual(
    normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } }),
    {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cache_read_tokens: 4,
    },
  );

  // Anthropic style
  t.deepEqual(
    normalizeUsage({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 12,
    }),
    {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 137,
      cache_read_tokens: 60,
      cache_creation_tokens: 12,
    },
  );

  // Agents SDK style
  t.deepEqual(normalizeUsage({ inputTokens: 5, outputTokens: 15, totalTokens: 20 }), {
    prompt_tokens: 5,
    completion_tokens: 15,
    total_tokens: 20,
  });

  // Mixed/partial
  t.deepEqual(normalizeUsage({ input_tokens: 100 }), {
    prompt_tokens: 100,
    total_tokens: 100,
  });
});

test('normalizeAgentRunUsage reads the SDK run-state accumulator and sums per-request detail arrays', (t) => {
  // Shape mirrors @openai/agents-core Usage: cumulative scalar totals plus
  // per-request detail arrays for cache/reasoning.
  t.deepEqual(
    normalizeAgentRunUsage({
      requests: 3,
      inputTokens: 6000,
      outputTokens: 280,
      totalTokens: 6280,
      inputTokensDetails: [{ cached_tokens: 500 }, { cached_tokens: 1000 }, { cached_tokens: 0 }],
      outputTokensDetails: [{ reasoning_tokens: 40 }, { reasoning_tokens: 60 }, {}],
    }),
    {
      prompt_tokens: 6000,
      completion_tokens: 280,
      total_tokens: 6280,
      cache_read_tokens: 1500,
      reasoning_tokens: 100,
    },
  );
});

test('normalizeAgentRunUsage treats an all-zero accumulator as absent', (t) => {
  t.is(
    normalizeAgentRunUsage({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [],
      outputTokensDetails: [],
    }),
    undefined,
  );
  t.is(normalizeAgentRunUsage(undefined), undefined);
  t.is(normalizeAgentRunUsage(null), undefined);
});

test('extractUsage finds usage in nested locations', (t) => {
  const payload = {
    usage: { prompt_tokens: 1, total_tokens: 3 },
    response: { usage: { completion_tokens: 2, total_tokens: 3 } },
  };
  t.deepEqual(extractUsage(payload), {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
});

test('extractUsage preserves cache usage when merging normalized sources', (t) => {
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

  t.deepEqual(extractUsage(payload), {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    cache_read_tokens: 4,
  });
});

test('extractUsage finds usage in raw model stream event payload shape', (t) => {
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

  t.deepEqual(extractUsage(payload), {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
  });
});

test('formatFooterUsage returns formatted string', (t) => {
  t.is(
    formatFooterUsage({ prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550 }),
    'Tok: 1,200 in / 350 out',
  );
  t.is(
    formatFooterUsage({
      prompt_tokens: 1200,
      completion_tokens: 350,
      total_tokens: 1550,
      cache_read_tokens: 900,
      cache_creation_tokens: 120,
    }),
    'Tok: 1,200 in (900 cached, 120 cache write) / 350 out',
  );
  t.is(
    formatFooterUsage({ prompt_tokens: 2054, completion_tokens: 74, cache_read_tokens: 1920 }),
    'Tok: 2,054 in (1,920 cached) / 74 out',
  );
  t.is(formatFooterUsage({ cache_read_tokens: 42 }), '');
  t.is(formatFooterUsage({ total_tokens: 100 }), '');
  t.is(formatFooterUsage(null), '');
});

test('addTokenUsage accumulates usage counters', (t) => {
  t.deepEqual(
    addTokenUsage(
      { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 800 },
      { prompt_tokens: 2000, completion_tokens: 300, cache_read_tokens: 1200, cache_creation_tokens: 50 },
    ),
    {
      prompt_tokens: 3000,
      completion_tokens: 500,
      cache_read_tokens: 2000,
      cache_creation_tokens: 50,
    },
  );

  t.deepEqual(addTokenUsage(undefined, undefined), {});
});

test('addBillableSessionTokenUsage subtracts cached input before accumulating prompt tokens', (t) => {
  t.deepEqual(
    addBillableSessionTokenUsage(
      { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 50 },
      { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 800 },
    ),
    {
      prompt_tokens: 300,
      completion_tokens: 220,
      cache_read_tokens: 850,
    },
  );

  t.deepEqual(addBillableSessionTokenUsage(undefined, { prompt_tokens: 100, cache_read_tokens: 150 }), {
    prompt_tokens: 0,
    cache_read_tokens: 150,
  });
});

test('createUsageAccumulator adds billable input and resets session usage', (t) => {
  const accumulator = createUsageAccumulator({ prompt_tokens: 10, completion_tokens: 2 });
  accumulator.add({ prompt_tokens: 5, completion_tokens: 3, cache_read_tokens: 4 });

  t.deepEqual(accumulator.get(), {
    prompt_tokens: 11,
    completion_tokens: 5,
    cache_read_tokens: 4,
  });

  accumulator.reset();
  t.deepEqual(accumulator.get(), {});
});

test('createUsageAccumulator subtracts cached input on every model turn', (t) => {
  const accumulator = createUsageAccumulator();

  accumulator.add({ prompt_tokens: 1000, completion_tokens: 100, cache_read_tokens: 800 });
  t.deepEqual(accumulator.get(), {
    prompt_tokens: 200,
    completion_tokens: 100,
    cache_read_tokens: 800,
  });

  accumulator.add({ prompt_tokens: 1000, completion_tokens: 100, cache_read_tokens: 800 });
  t.deepEqual(accumulator.get(), {
    prompt_tokens: 400,
    completion_tokens: 200,
    cache_read_tokens: 1600,
  });
});

test('formatSessionTokenUsage matches slash command output', (t) => {
  t.is(
    formatSessionTokenUsage({
      prompt_tokens: 20000,
      completion_tokens: 20000,
      cache_read_tokens: 1000000,
      cache_creation_tokens: 500,
    }),
    'Token usage: 20,000 input (1,000,000 cached), 20,000 output',
  );

  t.is(formatSessionTokenUsage({ prompt_tokens: 100, completion_tokens: 20 }), 'Token usage: 100 input, 20 output');
  t.is(formatSessionTokenUsage(null), 'Token usage: 0 input, 0 output');
});

test('formatSessionUsageBreakdown shows breakdown when subagent usage exists', (t) => {
  const main: any = { prompt_tokens: 6827, completion_tokens: 268, cache_read_tokens: 6656 };
  const sub: any = { prompt_tokens: 1000, completion_tokens: 50, cache_read_tokens: 500 };

  const result = formatSessionUsageBreakdown(main, sub);
  const lines = result.split('\n');

  t.is(lines.length, 3);
  t.is(lines[0], 'Main: 6,827 input (6,656 cached), 268 output');
  t.is(lines[1], 'Subagents: 1,000 input (500 cached), 50 output');
  t.is(lines[2], 'Total: 7,827 input (7,156 cached), 318 output');
});

test('formatSessionUsageBreakdown falls back to single line when no subagent usage', (t) => {
  const main: any = { prompt_tokens: 6827, completion_tokens: 268, cache_read_tokens: 6656 };

  t.is(formatSessionUsageBreakdown(main, null), 'Token usage: 6,827 input (6,656 cached), 268 output');
  t.is(formatSessionUsageBreakdown(main, undefined), 'Token usage: 6,827 input (6,656 cached), 268 output');
  t.is(formatSessionUsageBreakdown(main, {}), 'Token usage: 6,827 input (6,656 cached), 268 output');
});

test('formatSessionUsageBreakdown single-line fallback when subagent usage is all zeros', (t) => {
  const main: any = { prompt_tokens: 100, completion_tokens: 20 };
  const sub: any = { prompt_tokens: 0, completion_tokens: 0 };

  t.is(formatSessionUsageBreakdown(main, sub), 'Token usage: 100 input, 20 output');
});

test('formatSessionUsageBreakdown always shows three lines when subagent has non-zero usage', (t) => {
  const main: any = { prompt_tokens: 100, completion_tokens: 20 };
  const sub: any = { prompt_tokens: 0, completion_tokens: 5 };

  const result = formatSessionUsageBreakdown(main, sub);
  const lines = result.split('\n');

  t.is(lines.length, 3);
  t.is(lines[0], 'Main: 100 input, 20 output');
  t.is(lines[1], 'Subagents: 0 input, 5 output');
  t.is(lines[2], 'Total: 100 input, 25 output');
});

test('extractUsage does NOT find usage from RunResult.state.usage shape', (t) => {
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

  t.is(extractUsage(runResult), undefined, 'extractUsage should miss RunResult.state.usage');
});

test('normalizeAgentRunUsage extracts usage from SDK Usage shape with inputTokens/outputTokens', (t) => {
  // This is the fix path: normalizeAgentRunUsage understands the SDK's
  // Usage class shape and converts it to NormalizedUsage.
  const sdkUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };

  t.deepEqual(normalizeAgentRunUsage(sdkUsage), {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });
});
