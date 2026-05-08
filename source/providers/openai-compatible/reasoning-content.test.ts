import test from 'ava';
import { ReadableStream } from 'node:stream/web';
import type { AssistantMessageItem } from '@openai/agents';
import { OpenAICompatibleModel } from './model.js';
import { createMockSettingsService } from '../../services/settings-service.mock.js';
import { LoggingService } from '../../services/logging-service.js';

// Extended message type with provider-specific reasoning property
type ExtendedMessageItem = AssistantMessageItem & {
  reasoning?: string;
  reasoning_content?: string;
};

const logger = new LoggingService({ disableLogging: true });

const mockSettingsService = createMockSettingsService({
  providers: [
    {
      name: 'custom',
      baseUrl: 'https://api.example.com',
      apiKey: 'mock-api-key',
    },
  ],
  agent: {
    provider: 'custom',
  },
});

const createJsonResponse = (body: any) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test.serial('OpenAICompatibleModel.getResponse support reasoning_content', async (t) => {
  globalThis.fetch = async () =>
    createJsonResponse({
      id: 'resp-1',
      choices: [
        {
          message: {
            content: 'Hello',
            reasoning_content: 'thinking about user greeting',
          },
        },
      ],
      usage: {},
    });

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const response = await model.getResponse({
    input: 'hi',
  } as any);

  const assistantMessage = response.output.find((o): o is ExtendedMessageItem => o.type === 'message');
  t.truthy(assistantMessage);
  t.falsy(assistantMessage?.reasoning);
  t.is(assistantMessage?.reasoning_content, 'thinking about user greeting');
});

test.serial('OpenAICompatibleModel.getResponse replays prior reasoning_content in follow-up requests', async (t) => {
  const requestBodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return createJsonResponse({
      id: `resp-${requestBodies.length}`,
      choices: [
        {
          message: {
            content: 'Hello',
            reasoning_content: 'thinking about user greeting',
          },
        },
      ],
      usage: {},
    });
  };

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const first = await model.getResponse({
    input: 'hi',
  } as any);

  await model.getResponse({
    input: [
      { role: 'user', type: 'message', content: 'hi' },
      ...first.output,
      { role: 'user', type: 'message', content: 'again' },
    ],
  } as any);

  const assistantMessage = requestBodies[1].messages.find((message: any) => message.role === 'assistant');
  t.truthy(assistantMessage);
  t.is(assistantMessage.reasoning_content, 'thinking about user greeting');
  t.is(assistantMessage.reasoning, undefined);
});

test.serial('OpenAICompatibleModel.getStreamedResponse support reasoning_content', async (t) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"ing"}}]}\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () =>
    new Response(stream as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({
    input: 'hi',
  } as any)) {
    events.push(event);
  }

  const doneEvent = events.find((e) => e.type === 'response_done');
  t.truthy(doneEvent);
  const assistantMessage = doneEvent.response.output.find((o: any) => o.type === 'message');
  t.truthy(assistantMessage);
  t.falsy(assistantMessage.reasoning);
  t.is(assistantMessage.reasoning_content, 'thinking');
  t.is(assistantMessage.content[0].text, 'Hi');
});

test.serial('OpenAICompatibleModel.getStreamedResponse replays reasoning_content for tool calls', async (t) => {
  const requestBodies: any[] = [];
  const encoder = new TextEncoder();

  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    if (requestBodies.length > 1) {
      return createJsonResponse({
        id: 'resp-follow-up',
        choices: [{ message: { content: 'done' } }],
        usage: {},
      });
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking before tool"}}]}\n'),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"id":"resp-tools-stream","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-stream-1","type":"function","function":{"name":"shell","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n',
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });

    return new Response(stream as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({
    input: 'hi',
  } as any)) {
    events.push(event);
  }

  const doneEvent = events.find((event) => event.type === 'response_done');
  const toolCall = doneEvent.response.output.find((item: any) => item.type === 'function_call') as any;

  await model.getResponse({
    input: [
      { role: 'user', type: 'message', content: 'hi' },
      {
        ...toolCall,
        reasoning_content: undefined,
        rawItem: {
          ...toolCall,
          reasoning_content: undefined,
        },
      },
      { type: 'function_call_result', callId: 'call-stream-1', output: 'ok' },
    ],
  } as any);

  const assistantMessage = requestBodies[1].messages.find((message: any) => message.role === 'assistant');
  t.truthy(assistantMessage);
  t.is(assistantMessage.reasoning_content, 'thinking before tool');
});

test.serial('OpenAICompatibleModel.getResponse trims tool call names', async (t) => {
  globalThis.fetch = async () =>
    createJsonResponse({
      id: 'resp-tools-trim',
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-trim-1',
                type: 'function',
                function: {
                  name: ' shell ',
                  arguments: '{"command":"ls"}',
                },
              },
            ],
          },
        },
      ],
      usage: {},
    });

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const response = await model.getResponse({
    input: 'hi',
  } as any);

  const toolCall = response.output.find((item: any) => item.type === 'function_call') as any;
  t.truthy(toolCall);
  t.is(toolCall.name, 'shell');
});

test.serial('OpenAICompatibleModel.getStreamedResponse trims tool call names', async (t) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"resp-tools-stream","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-stream-1","type":"function","function":{"name":" shell ","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });

  globalThis.fetch = async () =>
    new Response(stream as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  const model = new OpenAICompatibleModel({
    settingsService: mockSettingsService,
    loggingService: logger,
    providerId: 'custom',
    baseUrl: 'https://api.example.com',
    apiKey: 'mock-api-key',
    modelId: 'test-model',
  });

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({
    input: 'hi',
  } as any)) {
    events.push(event);
  }

  const doneEvent = events.find((event) => event.type === 'response_done');
  t.truthy(doneEvent);
  const toolCall = doneEvent.response.output.find((item: any) => item.type === 'function_call') as any;
  t.truthy(toolCall);
  t.is(toolCall.name, 'shell');
});
