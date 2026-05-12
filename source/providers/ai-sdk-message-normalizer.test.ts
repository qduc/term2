import test from 'ava';
import { mergeAssistantMessages, withMergedAssistantMessages } from './ai-sdk-message-normalizer.js';

test('mergeAssistantMessages folds assistant reasoning into following assistant tool call', (t) => {
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

  t.deepEqual(mergeAssistantMessages(messages), [
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

test('mergeAssistantMessages folds AI SDK reasoning content part into following assistant tool call', (t) => {
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

  t.deepEqual(mergeAssistantMessages(messages), [
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

test('mergeAssistantMessages preserves assistant messages separated by non-assistant messages', (t) => {
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

  t.deepEqual(mergeAssistantMessages(messages), messages);
});

test('mergeAssistantMessages merges contiguous assistant messages', (t) => {
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second', reasoning_content: 'reasoning-a' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    { role: 'tool', tool_call_id: 'call:0', content: 'result' },
    { role: 'assistant', content: 'after tool' },
  ];

  t.deepEqual(mergeAssistantMessages(messages), [
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

test('mergeAssistantMessages merges contiguous AI SDK assistant content parts', (t) => {
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

  t.deepEqual(mergeAssistantMessages(messages), [
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

test('mergeAssistantMessages merges real-world split assistant turns before tool results', (t) => {
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

  t.deepEqual(mergeAssistantMessages(messages), [
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

test('withMergedAssistantMessages normalizes doGenerate messages before delegating', async (t) => {
  let delegatedOptions: any;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async (options: any) => {
      delegatedOptions = options;
      return { text: 'ok' };
    },
    doStream: async () => ({ stream: [] }),
  });

  await model.doGenerate({
    temperature: 0,
    messages: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  });

  t.deepEqual(delegatedOptions, {
    temperature: 0,
    messages: [{ role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] }],
  });
});

test('withMergedAssistantMessages normalizes doGenerate prompt before delegating', async (t) => {
  let delegatedOptions: any;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async (options: any) => {
      delegatedOptions = options;
      return { text: 'ok' };
    },
    doStream: async () => ({ stream: [] }),
  });

  await model.doGenerate({
    prompt: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  });

  t.deepEqual(delegatedOptions.prompt, [
    { role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] },
  ]);
});

test('withMergedAssistantMessages normalizes doStream messages before delegating', async (t) => {
  let delegatedOptions: any;
  const model = withMergedAssistantMessages({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ text: 'ok' }),
    doStream: async (options: any) => {
      delegatedOptions = options;
      return { stream: [] };
    },
  });

  await model.doStream({
    messages: [
      { role: 'assistant', content: '', reasoning_content: 'reasoning' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:0' }] },
    ],
  });

  t.deepEqual(delegatedOptions.messages, [
    { role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call:0' }] },
  ]);
});

test('withMergedAssistantMessages preserves model properties exposed by getters', (t) => {
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
      return 'v3';
    }

    get supportedUrls() {
      return {};
    }

    async doGenerate() {
      return { text: 'ok' };
    }

    async doStream() {
      return { stream: [] };
    }
  }

  const model = withMergedAssistantMessages(new GetterBackedModel());

  t.is(model.provider, 'example.chat');
  t.is(model.modelId, 'selected-model');
  t.is(model.specificationVersion, 'v3');
  t.deepEqual(model.supportedUrls, {});
});
