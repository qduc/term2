import test from 'ava';
import {ReadableStream} from 'node:stream/web';
import {OpenRouterModel, clearOpenRouterConversations} from './openrouter.js';
import { settingsService } from '../services/settings-service.js';
import {loggingService} from '../services/logging-service.js';

const originalFetch = globalThis.fetch;
const originalGet = settingsService.get;
const originalLogToOpenrouter = loggingService.logToOpenrouter.bind(loggingService);

const createJsonResponse = (body: any) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });

test.beforeEach(() => {
    clearOpenRouterConversations();
    settingsService.get = ((key: string) => {
        if (key === 'agent.openrouter.apiKey') {
            return 'mock-api-key';
        }
        return originalGet.call(settingsService, key);
    }) as any;
});

test.afterEach.always(() => {
    clearOpenRouterConversations();
    globalThis.fetch = originalFetch;
    settingsService.get = originalGet;
    loggingService.logToOpenrouter = originalLogToOpenrouter as any;
});

test.serial('builds messages with history, tool calls, and reasoning config', async t => {
    const requests: any[] = [];
    const responses = [
        createJsonResponse({
            id: 'resp-1',
            choices: [
                {
                    message: {
                        content: 'Hello back',
                        reasoning_details: [{type: 'text', text: 'thinking'}],
                    },
                },
            ],
            usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3},
        }),
        createJsonResponse({
            id: 'resp-2',
            choices: [{message: {content: 'Second turn reply'}}],
            usage: {prompt_tokens: 2, completion_tokens: 1, total_tokens: 3},
        }),
    ];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return responses[requests.length - 1];
    };

    const model = new OpenRouterModel('mock-model');

    await model.getResponse({
        systemInstructions: 'system message',
        input: 'First user turn',
        modelSettings: {reasoningEffort: 'high'},
    } as any);

    const secondTurnItems = [
        {type: 'input_text', text: 'Second user turn'},
        {
            type: 'function_call',
            id: 'call-123',
            name: 'bash',
            arguments: '{"cmd":"ls"}',
        },
        {type: 'function_call_result', callId: 'call-123', output: 'files\n'},
    ];

    await model.getResponse({
        systemInstructions: 'system message',
        input: secondTurnItems as any,
        previousResponseId: 'resp-1',
    } as any);

    t.truthy(requests[0]);
    t.deepEqual(requests[0].reasoning, {effort: 'high'});
    t.deepEqual(requests[0].tools, []);

    const secondRequest = requests[1];
    t.truthy(secondRequest);
    t.deepEqual(secondRequest.messages, [
        {role: 'system', content: 'system message'},
        {role: 'user', content: 'First user turn'},
        {
            role: 'assistant',
            content: 'Hello back',
            reasoning_details: [{type: 'text', text: 'thinking'}],
        },
        {role: 'user', content: 'Second user turn'},
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'call-123',
                    type: 'function',
                    function: {name: 'bash', arguments: '{"cmd":"ls"}'},
                },
            ],
        },
        {role: 'tool', tool_call_id: 'call-123', content: 'files\n'},
    ]);
});

test.serial('logs expanded modelRequest input when using previousResponseId', async t => {
    const logged: any[] = [];
    loggingService.logToOpenrouter = ((level: string, message: string, meta?: any) => {
        logged.push({level, message, meta});
    }) as any;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    'data: {"id":"resp-2","choices":[{"delta":{"content":"ok"}}]}\n',
                ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
        },
    });

    const responses = [
        createJsonResponse({
            id: 'resp-1',
            choices: [{message: {content: 'first response'}}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
        }),
        new Response(stream, {
            status: 200,
            headers: {'Content-Type': 'text/event-stream'},
        }),
    ];

    let call = 0;
    globalThis.fetch = async (_url, options: any) => {
        JSON.parse(options.body);
        return responses[call++];
    };

    const model = new OpenRouterModel('mock-model');

    await model.getResponse({
        systemInstructions: 'system message',
        input: [
            {type: 'message', role: 'user', content: 'First user turn'},
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'First assistant turn'}],
                status: 'completed',
            },
            {
                type: 'function_call',
                callId: 'call-123',
                name: 'grep',
                arguments: '{"pattern":"x"}',
                status: 'completed',
            },
            {
                type: 'function_call_result',
                callId: 'call-123',
                name: 'grep',
                output: {type: 'text', text: 'match'},
                status: 'completed',
            },
        ] as any,
    } as any);

    for await (const _event of model.getStreamedResponse({
        systemInstructions: 'system message',
        previousResponseId: 'resp-1',
        input: [
            {
                type: 'function_call_result',
                callId: 'call-999',
                name: 'shell',
                output: 'done',
                status: 'completed',
            },
        ] as any,
    } as any)) {
        // consume
    }

    const modelRequestLog = logged.find(entry => entry.message === 'modelRequest');
    t.truthy(modelRequestLog);
    t.true(Array.isArray(modelRequestLog.meta?.input));
    t.true(
        modelRequestLog.meta.input.some(
            (item: any) =>
                item?.type === 'message' &&
                item?.role === 'user' &&
                item?.content === 'First user turn',
        ),
    );
    t.true(
        modelRequestLog.meta.input.some((item: any) => item?.type === 'function_call'),
    );
});

test.serial('streams reasoning details and stores assistant history', async t => {
    const requests: any[] = [];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    'data: {"id":"resp-stream","choices":[{"delta":{"content":"Hello","reasoning_details":[{"type":"reasoning.text","text":"step1","format":null,"index":0}]}}]}\n',
                ),
            );
            controller.enqueue(
                encoder.encode(
                    'data: {"choices":[{"delta":{"content":"!"}}]}\n',
                ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
        },
    });

    const responses = [
        new Response(stream, {
            status: 200,
            headers: {'Content-Type': 'text/event-stream'},
        }),
        createJsonResponse({
            id: 'resp-stream-2',
            choices: [{message: {content: 'Follow up'}}],
            usage: {},
        }),
    ];

    let call = 0;
    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return responses[call++];
    };

    const model = new OpenRouterModel('mock-model');
    const streamedEvents: any[] = [];

    for await (const event of model.getStreamedResponse({
        systemInstructions: 'system message',
        input: 'Streaming input',
    } as any)) {
        streamedEvents.push(event);
    }

    const doneEvent = streamedEvents.find(event => event.type === 'response_done');
    t.truthy(doneEvent);

    // First output item should be reasoning
    const reasoningOutput = doneEvent.response.output[0];
    t.is(reasoningOutput.type, 'reasoning');
    t.is(reasoningOutput.content[0].text, 'step1');
    t.is(reasoningOutput.providerData.type, 'reasoning.text');

    // Second output item should be the message
    t.is(doneEvent.response.output[1].content[0].text, 'Hello!');

    await model.getResponse({
        systemInstructions: 'system message',
        input: 'Next input',
        previousResponseId: 'resp-stream',
    } as any);

    const followUpRequest = requests[1];
    const assistantHistory = followUpRequest.messages.find(
        (msg: any) => msg.role === 'assistant' && msg.reasoning_details,
    );

    t.truthy(assistantHistory);
    t.is(assistantHistory.reasoning_details[0].type, 'reasoning.text');
    t.is(assistantHistory.reasoning_details[0].text, 'step1');
});

test.serial('converts user message items in array inputs', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return new Response(JSON.stringify({choices: [{message: {content: 'ok'}}], usage: {}}), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });
    };

    const model = new OpenRouterModel('mock-model');

    await model.getResponse({
        systemInstructions: 'system message',
        input: [{type: 'message', role: 'user', content: 'hi'}] as any,
    } as any);

    t.truthy(requests[0]);
    t.deepEqual(requests[0].messages, [
        {role: 'system', content: 'system message'},
        {role: 'user', content: 'hi'},
    ]);
});

test.serial('handles summary reasoning details', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-summary',
            choices: [
                {
                    message: {
                        content: '1 + 1 equals 2.\n\nThis is the fundamental rule of addition in basic arithmetic, where adding 1 to 1 results in 2. For example, if you have one apple and get one more, you have two apples.',
                        reasoning: 'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                        reasoning_details: [
                            {
                                format: 'xai-responses-v1',
                                index: 0,
                                type: 'reasoning.summary',
                                summary: 'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                            },
                        ],
                    },
                },
            ],
            usage: {prompt_tokens: 10, completion_tokens: 50, total_tokens: 60},
        });
    };

    const model = new OpenRouterModel('mock-model');
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'What is 1 + 1',
    } as any);

    // Should have two output items: reasoning and message
    t.is(response.output.length, 2);

    // First item should be summary reasoning
    const reasoningOutput = response.output[0];
    t.is(reasoningOutput.type, 'reasoning');
    t.is(reasoningOutput.content.length, 1);
    t.is(reasoningOutput.content[0].type, 'input_text');
    t.is(reasoningOutput.content[0].text, 'First, the user asked "What is 1 + 1", which is a simple math question.\n');
    t.is(reasoningOutput.providerData.type, 'reasoning.summary');
    t.is(reasoningOutput.providerData.format, 'xai-responses-v1');
    t.is(reasoningOutput.providerData.summary, 'First, the user asked "What is 1 + 1", which is a simple math question.\n');

    // Second item should be the message
    t.is(response.output[1].type, 'message');
    t.truthy(response.output[1].content[0].text.includes('1 + 1 equals 2'));
});

test.serial('handles encrypted reasoning details', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-encrypted',
            choices: [
                {
                    message: {
                        content: 'Response with encrypted reasoning',
                        reasoning_details: [
                            {
                                id: 'rs_05c9be144fb3fa3b016936cb941e48819183e63b141a094cac',
                                format: 'openai-responses-v1',
                                index: 0,
                                type: 'reasoning.encrypted',
                                data: 'gAAAAABpNsuVfXBOvLwub1...',
                            },
                        ],
                    },
                },
            ],
            usage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30},
        });
    };

    const model = new OpenRouterModel('mock-model');
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'Test encrypted reasoning',
    } as any);

    // Should have two output items: reasoning and message
    t.is(response.output.length, 2);

    // First item should be encrypted reasoning
    const reasoningOutput = response.output[0];
    t.is(reasoningOutput.type, 'reasoning');
    t.deepEqual(reasoningOutput.content, []); // No displayable content for encrypted
    t.is(reasoningOutput.providerData.type, 'reasoning.encrypted');
    t.is(reasoningOutput.providerData.id, 'rs_05c9be144fb3fa3b016936cb941e48819183e63b141a094cac');
    t.is(reasoningOutput.providerData.format, 'openai-responses-v1');
    t.is(reasoningOutput.providerData.data, 'gAAAAABpNsuVfXBOvLwub1...');

    // Second item should be the message
    t.is(response.output[1].type, 'message');
    t.is(response.output[1].content[0].text, 'Response with encrypted reasoning');
});

test.serial('correctly converts function_call_output to tool message', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-1',
            choices: [{message: {content: 'ok'}}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
        });
    };

    const model = new OpenRouterModel('mock-model');

    // Simulate a conversation turn with function_call_output
    const inputItems = [
        {type: 'input_text', text: 'User message'},
        {
            type: 'function_call',
            id: 'call-abc',
            name: 'search_replace',
            arguments: '{"path":"test.txt","search_content":"old","replace_content":"new"}',
        },
        {
            rawItem: {
                type: 'function_call_output',
                callId: 'call-abc',
                id: 'call-abc',
                name: 'search_replace',
                output: '{"output":[{"success":true}]}'
            }
        },
    ];

    await model.getResponse({
        systemInstructions: 'system message',
        input: inputItems as any,
    } as any);

    t.truthy(requests[0]);
    const messages = requests[0].messages;

    // Should have: system, user, assistant (with tool_calls), tool (with result)
    t.is(messages.length, 4);
    t.is(messages[0].role, 'system');
    t.is(messages[1].role, 'user');
    t.is(messages[1].content, 'User message');

    // function_call should be converted to assistant message with tool_calls
    t.is(messages[2].role, 'assistant');
    t.is(messages[2].content, null);
    t.truthy(messages[2].tool_calls);
    t.is(messages[2].tool_calls[0].id, 'call-abc');
    t.is(messages[2].tool_calls[0].function.name, 'search_replace');

    // function_call_output should be converted to tool message, NOT another assistant message
    t.is(messages[3].role, 'tool');
    t.is(messages[3].tool_call_id, 'call-abc');
    t.truthy(messages[3].content);
});

test.serial('handles mixed reasoning types (summary + encrypted)', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-mixed',
            choices: [
                {
                    message: {
                        content: '1 + 1 equals 2.\n\nThis is the fundamental rule of addition.',
                        reasoning: 'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                        reasoning_details: [
                            {
                                format: 'xai-responses-v1',
                                index: 0,
                                type: 'reasoning.summary',
                                summary: 'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                            },
                            {
                                id: 'rs_b908e80d-7948-923b-a82b-0a61eba37a92',
                                format: 'xai-responses-v1',
                                index: 1,
                                type: 'reasoning.encrypted',
                                data: 'zDzBlL2u7sDbq1l6rOpNL',
                            },
                        ],
                    },
                },
            ],
            usage: {prompt_tokens: 10, completion_tokens: 50, total_tokens: 60},
        });
    };

    const model = new OpenRouterModel('mock-model');
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'What is 1 + 1',
    } as any);

    // Should have three output items: summary reasoning, encrypted reasoning, and message
    t.is(response.output.length, 3);

    // First item should be summary reasoning
    const summaryOutput = response.output[0];
    t.is(summaryOutput.type, 'reasoning');
    t.is(summaryOutput.content[0].text, 'First, the user asked "What is 1 + 1", which is a simple math question.\n');
    t.is(summaryOutput.providerData.type, 'reasoning.summary');

    // Second item should be encrypted reasoning
    const encryptedOutput = response.output[1];
    t.is(encryptedOutput.type, 'reasoning');
    t.deepEqual(encryptedOutput.content, []); // No displayable content
    t.is(encryptedOutput.providerData.type, 'reasoning.encrypted');
    t.is(encryptedOutput.providerData.data, 'zDzBlL2u7sDbq1l6rOpNL');

    // Third item should be the message
    t.is(response.output[2].type, 'message');
    t.truthy(response.output[2].content[0].text.includes('1 + 1 equals 2'));
});

test.serial('preserves assistant message content when tool calls are present', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-with-tools',
            choices: [{message: {content: 'Response after tools'}}],
            usage: {prompt_tokens: 5, completion_tokens: 3, total_tokens: 8},
        });
    };

    const model = new OpenRouterModel('mock-model');

    // First turn - get initial response
    await model.getResponse({
        systemInstructions: 'system message',
        input: 'First turn',
    } as any);

    // Second turn - assistant message with both content and tool calls
    await model.getResponse({
        systemInstructions: 'system message',
        input: [
            {type: 'input_text', text: 'User message'},
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'I will use a tool'}],
                tool_calls: [
                    {
                        id: 'call-456',
                        type: 'function',
                        function: {name: 'search', arguments: '{"query":"test"}'},
                    },
                ],
            },
            {type: 'function_call_result', callId: 'call-456', output: 'search results'},
        ] as any,
        previousResponseId: 'resp-with-tools',
    } as any);

    const secondRequest = requests[1];
    t.truthy(secondRequest);

    // Find the assistant message with tool calls
    const assistantMsg = secondRequest.messages.find(
        (m: any) => m.role === 'assistant' && m.tool_calls,
    );
    t.truthy(assistantMsg);

    // Verify both content and tool_calls are preserved
    t.is(assistantMsg.content, 'I will use a tool');
    t.truthy(assistantMsg.tool_calls);
    t.is(assistantMsg.tool_calls.length, 1);
    t.is(assistantMsg.tool_calls[0].id, 'call-456');
    t.is(assistantMsg.tool_calls[0].function.name, 'search');
});
