import test from 'ava';
import {
  addBillableSessionTokenUsage,
  addTokenUsage,
  createUsageAccumulator,
  extractUsage,
  formatFooterUsage,
  formatSessionTokenUsage,
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
