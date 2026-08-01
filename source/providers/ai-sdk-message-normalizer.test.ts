import { it, expect } from 'vitest';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { mergeAssistantMessages, withMergedAssistantMessages } from './ai-sdk-message-normalizer.js';

it('mergeAssistantMessages folds assistant reasoning into following assistant tool call', () => {
  const messages = [
    { role: 'user', content: 'what time is it?' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'Need to use the shell for the exact time.',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'shell:0',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"date"}',
          },
        },
      ],
    },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    { role: 'user', content: 'what time is it?' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to use the shell for the exact time.',
      tool_calls: [
        {
          id: 'shell:0',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"date"}',
          },
        },
      ],
    },
  ]);
});

it('mergeAssistantMessages preserves reasoning-only assistant messages that still need to be replayed', () => {
  const messages = [
    { role: 'user', content: 'show package json' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should inspect the file.',
      reasoning_details: [{ type: 'reasoning.text', text: 'I should inspect the file.' }],
    },
    { role: 'user', content: 'retry after failed hallucinated tool call' },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    { role: 'user', content: 'show package json' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should inspect the file.',
      reasoning_details: [{ type: 'reasoning.text', text: 'I should inspect the file.' }],
    },
    { role: 'user', content: 'retry after failed hallucinated tool call' },
  ]);
});

it('mergeAssistantMessages folds AI SDK reasoning content part into following assistant tool call', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Need to use the shell for the exact time.',
          providerOptions: {},
        },
      ],
      providerOptions: {},
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'shell:0',
          toolName: 'shell',
          input: {
            command: 'date',
          },
          providerOptions: {},
        },
      ],
      providerOptions: {},
    },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Need to use the shell for the exact time.',
          providerOptions: {},
        },
        {
          type: 'tool-call',
          toolCallId: 'shell:0',
          toolName: 'shell',
          input: {
            command: 'date',
          },
          providerOptions: {},
        },
      ],
      providerOptions: {},
    },
  ]);
});

it('mergeAssistantMessages preserves assistant messages separated by non-assistant messages', () => {
  const messages = [
    {
      role: 'assistant',
      content: 'visible text',
      reasoning_content: 'internal reasoning',
    },
    {
      role: 'tool',
      tool_call_id: 'call:0',
      content: 'result',
    },
    {
      role: 'assistant',
      content: 'after tool',
    },
  ];

  expect(mergeAssistantMessages(messages)).toEqual(messages);
});

it('mergeAssistantMessages merges contiguous assistant messages', () => {
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second', reasoning_content: 'reasoning-a' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    { role: 'tool', tool_call_id: 'call:0', content: 'result' },
    { role: 'assistant', content: 'after tool' },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: 'first\nsecond',
      reasoning_content: 'reasoning-a',
      tool_calls: [{ id: 'call:0' }],
    },
    { role: 'tool', tool_call_id: 'call:0', content: 'result' },
    { role: 'assistant', content: 'after tool' },
  ]);
});

it('mergeAssistantMessages merges contiguous AI SDK assistant content parts', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'first' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call:0', toolName: 'shell', input: {} }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'second' }],
    },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool-call', toolCallId: 'call:0', toolName: 'shell', input: {} },
        { type: 'text', text: 'second' },
      ],
    },
  ]);
});

it('mergeAssistantMessages merges real-world split assistant turns before tool results', () => {
  const messages = [
    {
      role: 'system',
      content: [{ type: 'text', text: 'You are a lightweight terminal assistant fo...' }],
    },
    {
      role: 'user',
      content: 'Help me test if the grep tool in this enviro...',
    },
    {
      role: 'assistant',
      content: '',
      reasoning: 'The user wants me to test if the grep tool...',
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'The user wants me to test if the grep tool...',
          format: 'unknown',
          index: 0,
        },
      ],
    },
    {
      role: 'assistant',
      content: "I'll test the `grep` tool by running the sa...",
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'chatcmpl-tool-b7beee18ac56f10c',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"ls -la"}',
          },
        },
      ],
      reasoning_details: [],
    },
    {
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-b7beee18ac56f10c',
      content: 'exit 0\ntotal 1504\ndrwxr-xr-x@  34 qduc...',
      name: 'shell',
    },
    {
      role: 'assistant',
      content: '',
      reasoning: 'Let me look for some content to search for...',
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'Let me look for some content to search for...',
          format: 'unknown',
          index: 0,
        },
      ],
    },
    {
      role: 'assistant',
      content: 'Now let me pick a search term and run it wi...',
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'chatcmpl-tool-81bf68f7f26e9d9c',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"grep -r \\"grep\\" --include=\\"*.ts\\"...}',
          },
        },
      ],
      reasoning_details: [],
    },
    {
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-81bf68f7f26e9d9c',
      content: "exit 0\n./dist/tools/grep.js:        name: 'g...",
      name: 'shell',
    },
  ];

  expect(mergeAssistantMessages(messages)).toEqual([
    {
      role: 'system',
      content: [{ type: 'text', text: 'You are a lightweight terminal assistant fo...' }],
    },
    {
      role: 'user',
      content: 'Help me test if the grep tool in this enviro...',
    },
    {
      role: 'assistant',
      content: "I'll test the `grep` tool by running the sa...",
      reasoning: 'The user wants me to test if the grep tool...',
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'The user wants me to test if the grep tool...',
          format: 'unknown',
          index: 0,
        },
      ],
      tool_calls: [
        {
          id: 'chatcmpl-tool-b7beee18ac56f10c',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"ls -la"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-b7beee18ac56f10c',
      content: 'exit 0\ntotal 1504\ndrwxr-xr-x@  34 qduc...',
      name: 'shell',
    },
    {
      role: 'assistant',
      content: 'Now let me pick a search term and run it wi...',
      reasoning: 'Let me look for some content to search for...',
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'Let me look for some content to search for...',
          format: 'unknown',
          index: 0,
        },
      ],
      tool_calls: [
        {
          id: 'chatcmpl-tool-81bf68f7f26e9d9c',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"grep -r \\"grep\\" --include=\\"*.ts\\"...}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'chatcmpl-tool-81bf68f7f26e9d9c',
      content: "exit 0\n./dist/tools/grep.js:        name: 'g...",
      name: 'shell',
    },
  ]);
});

it('withMergedAssistantMessages normalizes doGenerate messages before delegating', async () => {
  let delegatedOptions: (LanguageModelV3CallOptions & { messages?: unknown[] }) | undefined;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      delegatedOptions = options as LanguageModelV3CallOptions & { messages?: unknown[] };
      return { text: 'ok' } as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    doStream: async () =>
      ({ stream: (async function* () {})() }) as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>,
  } as LanguageModelV3);

  await model.doGenerate({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [],
    temperature: 0,
    messages: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  } as unknown as LanguageModelV3CallOptions);

  expect(delegatedOptions).toEqual({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [],
    temperature: 0,
    messages: [{ role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] }],
  });
});

it('withMergedAssistantMessages normalizes doGenerate prompt before delegating', async () => {
  let delegatedOptions: LanguageModelV3CallOptions | undefined;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      delegatedOptions = options;
      return { text: 'ok' } as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    },
    doStream: async () =>
      ({ stream: (async function* () {})() }) as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>,
  } as LanguageModelV3);

  await model.doGenerate({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  } as unknown as LanguageModelV3CallOptions);

  expect(delegatedOptions?.prompt).toEqual([
    { role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] },
  ]);
});

it('withMergedAssistantMessages normalizes doStream messages before delegating', async () => {
  let delegatedOptions: (LanguageModelV3CallOptions & { messages?: unknown[] }) | undefined;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () =>
      ({ text: 'ok' }) as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>,
    doStream: async (options: LanguageModelV3CallOptions) => {
      delegatedOptions = options as LanguageModelV3CallOptions & { messages?: unknown[] };
      return { stream: (async function* () {})() } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    },
  } as LanguageModelV3);

  await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [],
    messages: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  } as unknown as LanguageModelV3CallOptions);

  expect(delegatedOptions?.messages).toEqual([
    { role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] },
  ]);
});

it('withMergedAssistantMessages preserves model properties exposed by getters', () => {
  class GetterBackedModel {
    #provider = 'example.chat';
    #modelId = 'selected-model';

    get provider() {
      return this.#provider;
    }

    get modelId() {
      return this.#modelId;
    }

    get specificationVersion() {
      return 'v3' as const;
    }

    get supportedUrls() {
      return {};
    }

    async doGenerate() {
      return { text: 'ok' } as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
    }

    async doStream() {
      return { stream: (async function* () {})() } as unknown as Awaited<ReturnType<LanguageModelV3['doStream']>>;
    }
  }

  const model = withMergedAssistantMessages(new GetterBackedModel());

  expect(model.provider).toBe('example.chat');
  expect(model.modelId).toBe('selected-model');
  expect(model.specificationVersion).toBe('v3');
  expect(model.supportedUrls).toEqual({});
});
