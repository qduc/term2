import test from 'ava';
import {ReadableStream} from 'node:stream/web';
import type {AssistantMessageItem} from '@openai/agents';
import {OpenAICompatibleModel} from './model.js';
import {createMockSettingsService} from '../../services/settings-service.mock.js';
import {LoggingService} from '../../services/logging-service.js';

// Extended message type with provider-specific reasoning property
type ExtendedMessageItem = AssistantMessageItem & {
    reasoning?: string;
};

const logger = new LoggingService({disableLogging: true});

const mockSettingsService = createMockSettingsService({
    providers: [
        {
            name: 'custom',
            baseUrl: 'https://api.example.com',
            apiKey: 'mock-api-key',
        }
    ],
    agent: {
        provider: 'custom',
    },
});

const createJsonResponse = (body: any) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });

test('OpenAICompatibleModel.getResponse support reasoning_content', async t => {
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

    const assistantMessage = response.output.find(
        (o): o is ExtendedMessageItem => o.type === 'message',
    );
    t.truthy(assistantMessage);
    t.is(assistantMessage?.reasoning, 'thinking about user greeting');
});

test('OpenAICompatibleModel.getStreamedResponse support reasoning_content', async t => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n',
                ),
            );
            controller.enqueue(
                encoder.encode(
                    'data: {"choices":[{"delta":{"reasoning_content":"ing"}}]}\n',
                ),
            );
            controller.enqueue(
                encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
                ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
        },
    });

    globalThis.fetch = async () =>
        new Response(stream as any, {
            status: 200,
            headers: {'Content-Type': 'text/event-stream'},
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

    const doneEvent = events.find(e => e.type === 'response_done');
    t.truthy(doneEvent);
    const assistantMessage = doneEvent.response.output.find((o: any) => o.type === 'message');
    t.truthy(assistantMessage);
    t.is(assistantMessage.reasoning, 'thinking');
    t.is(assistantMessage.content[0].text, 'Hi');
});
