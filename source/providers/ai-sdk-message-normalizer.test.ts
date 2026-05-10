import test from 'ava';
import { mergeAssistantReasoningIntoToolCalls, withMergedAssistantReasoning } from './ai-sdk-message-normalizer.js';

test('mergeAssistantReasoningIntoToolCalls folds assistant reasoning into following assistant tool call', (t) => {
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

  t.deepEqual(mergeAssistantReasoningIntoToolCalls(messages), [
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

test('mergeAssistantReasoningIntoToolCalls folds AI SDK reasoning content part into following assistant tool call', (t) => {
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

  t.deepEqual(mergeAssistantReasoningIntoToolCalls(messages), [
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

test('mergeAssistantReasoningIntoToolCalls preserves messages that are not split reasoning and tool calls', (t) => {
  const messages = [
    {
      role: 'assistant',
      content: 'visible text',
      reasoning_content: 'internal reasoning',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call:0' }],
    },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'already has a tool call',
      tool_calls: [{ id: 'call:1' }],
    },
  ];

  t.deepEqual(mergeAssistantReasoningIntoToolCalls(messages), messages);
});

test('withMergedAssistantReasoning normalizes doGenerate messages before delegating', async (t) => {
  let delegatedOptions: any;
  const model = withMergedAssistantReasoning({
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

test('withMergedAssistantReasoning normalizes doStream messages before delegating', async (t) => {
  let delegatedOptions: any;
  const model = withMergedAssistantReasoning({
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

test('withMergedAssistantReasoning preserves model properties exposed by getters', (t) => {
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

  const model = withMergedAssistantReasoning(new GetterBackedModel());

  t.is(model.provider, 'example.chat');
  t.is(model.modelId, 'selected-model');
  t.is(model.specificationVersion, 'v3');
  t.deepEqual(model.supportedUrls, {});
});
