import test from 'ava';
import {ReadableStream} from 'node:stream/web';
import type {AssistantMessageItem, ReasoningItem} from '@openai/agents';
import {OpenRouterModel, OpenRouterError} from './openrouter.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';
import {LoggingService} from '../services/logging-service.js';

// Extended message type with provider-specific reasoning properties
type ExtendedMessageItem = AssistantMessageItem & {
    reasoning?: string;
    reasoning_details?: Array<{type: string; text: string; format: string | null; index: number}>;
};

// Helper to extract text from message content (handles discriminated union)
const getContentText = (msg: AssistantMessageItem | undefined, index = 0): string | undefined => {
    const content = msg?.content?.[index];
    return content?.type === 'output_text' ? content.text : undefined;
};

const originalFetch = globalThis.fetch;

// Use a dedicated logger instance for this test suite (avoid deprecated singleton)
const logger = new LoggingService({disableLogging: true});
const originalLogToOpenrouter = logger.logToOpenrouter.bind(logger);

// Create a mock settings service with OpenRouter API key for tests
const mockSettingsService = createMockSettingsService({
    agent: {
        openrouter: {
            apiKey: 'mock-api-key',
        },
    },
});

const createJsonResponse = (body: any) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });

test.beforeEach(() => {
    // Nothing to do - mock is already configured
});

test.afterEach.always(() => {
    globalThis.fetch = originalFetch;
    logger.logToOpenrouter = originalLogToOpenrouter as any;
});

test.serial(
    'builds messages from explicit history, tool calls, and reasoning config',
    async t => {
        const requests: any[] = [];
        const responses = [
            createJsonResponse({
                id: 'resp-1',
                choices: [
                    {
                        message: {
                            content: 'Hello back',
                            reasoning_details: [
                                {type: 'text', text: 'thinking'},
                            ],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                },
            }),
            createJsonResponse({
                id: 'resp-2',
                choices: [{message: {content: 'Second turn reply'}}],
                usage: {
                    prompt_tokens: 2,
                    completion_tokens: 1,
                    total_tokens: 3,
                },
            }),
        ];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return responses[requests.length - 1];
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        await model.getResponse({
            systemInstructions: 'system message',
            input: 'First user turn',
            modelSettings: {reasoningEffort: 'high'},
        } as any);

        // Caller-managed history: include the prior user + assistant messages explicitly.
        const secondTurnItems = [
            {type: 'message', role: 'user', content: 'First user turn'},
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'Hello back'}],
                status: 'completed',
                reasoning_details: [{type: 'text', text: 'thinking'}],
            },
            {type: 'input_text', text: 'Second user turn'},
            {
                type: 'function_call',
                id: 'call-123',
                name: 'bash',
                arguments: '{"cmd":"ls"}',
            },
            {
                type: 'function_call_result',
                callId: 'call-123',
                output: 'files\n',
            },
        ];

        await model.getResponse({
            systemInstructions: 'system message',
            input: secondTurnItems as any,
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
    },
);

test.serial(
    'preserves assistant reasoning_details when nested under rawItem in history',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return new Response(
                JSON.stringify({
                    choices: [{message: {content: 'ok'}}],
                    usage: {},
                }),
                {
                    status: 200,
                    headers: {'Content-Type': 'application/json'},
                },
            );
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        await model.getResponse({
            systemInstructions: 'system message',
            input: [
                {type: 'message', role: 'user', content: 'hi'},
                {
                    rawItem: {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{type: 'output_text', text: 'Hello back'}],
                        reasoning_details: [{type: 'text', text: 'thinking'}],
                    },
                },
            ] as any,
        } as any);

        t.truthy(requests[0]);
        t.deepEqual(requests[0].messages, [
            {role: 'system', content: 'system message'},
            {role: 'user', content: 'hi'},
            {
                role: 'assistant',
                content: 'Hello back',
                reasoning_details: [{type: 'text', text: 'thinking'}],
            },
        ]);
    },
);

test.serial(
    'preserves assistant reasoning (reasoning tokens) in history messages',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-ok',
                choices: [{message: {content: 'ok'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        await model.getResponse({
            systemInstructions: 'system message',
            input: [
                {type: 'message', role: 'user', content: 'hi'},
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{type: 'output_text', text: 'Hello back'}],
                    reasoning: 'Thinking privately...',
                    reasoning_details: [
                        {
                            type: 'reasoning.text',
                            text: 'step1',
                            format: null,
                            index: 0,
                        },
                    ],
                },
            ] as any,
        } as any);

        t.truthy(requests[0]);
        t.deepEqual(requests[0].messages, [
            {role: 'system', content: 'system message'},
            {role: 'user', content: 'hi'},
            {
                role: 'assistant',
                content: 'Hello back',
                reasoning: 'Thinking privately...',
                reasoning_details: [
                    {
                        type: 'reasoning.text',
                        text: 'step1',
                        format: null,
                        index: 0,
                    },
                ],
            },
        ]);
    },
);

test.serial(
    'replays reasoning_details alongside tool_calls when stored on function_call items',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-ok',
                choices: [{message: {content: 'ok'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        await model.getResponse({
            systemInstructions: 'system message',
            input: [
                {type: 'message', role: 'user', content: 'hi'},
                {
                    type: 'function_call',
                    id: 'call-123',
                    name: 'bash',
                    arguments: '{"cmd":"ls"}',
                    reasoning_details: [
                        {
                            type: 'reasoning.text',
                            text: 'tool planning',
                            format: 'anthropic-claude-v1',
                            index: 0,
                        },
                    ],
                    reasoning: 'I should run ls',
                },
                {
                    type: 'function_call_result',
                    callId: 'call-123',
                    output: 'files\n',
                },
            ] as any,
        } as any);

        const messages = requests[0].messages;
        const assistantWithToolCalls = messages.find(
            (m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls),
        );
        t.truthy(assistantWithToolCalls);
        t.deepEqual(assistantWithToolCalls.reasoning_details, [
            {
                type: 'reasoning.text',
                text: 'tool planning',
                format: 'anthropic-claude-v1',
                index: 0,
            },
        ]);
        t.is(assistantWithToolCalls.reasoning, 'I should run ls');
    },
);

test.serial(
    'reconstructs reasoning_details from standalone reasoning items before tool calls (Gemini requirement)',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-ok',
                choices: [{message: {content: 'ok'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        const input = [
            {
                role: 'user',
                type: 'message',
                content: 'do I have uncommitted change',
            },
            {
                id: 'reasoning-1',
                type: 'reasoning',
                providerData: {
                    type: 'reasoning.text',
                    text: 'step1',
                    format: 'google-gemini-v1',
                    index: 0,
                },
                content: [{type: 'input_text', text: 'step1'}],
            },
            {
                id: 'tool_shell_1',
                type: 'reasoning',
                providerData: {
                    id: 'tool_shell_1',
                    type: 'reasoning.encrypted',
                    data: 'ENC',
                    format: 'google-gemini-v1',
                    index: 1,
                },
                content: [],
            },
            {
                type: 'function_call',
                callId: 'tool_shell_1',
                name: 'shell',
                status: 'completed',
                arguments: '{"command":"git status"}',
            },
            {
                type: 'function_call_result',
                callId: 'tool_shell_1',
                name: 'shell',
                status: 'completed',
                output: {type: 'text', text: 'ok'},
            },
        ] as any;

        await model.getResponse({
            systemInstructions: 'system message',
            input,
        } as any);

        const body = requests[0];
        t.truthy(body);

        // Expect the reasoning blocks to be replayed as reasoning_details on the assistant tool_calls message.
        const assistantToolCall = body.messages.find(
            (m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls),
        );
        t.truthy(assistantToolCall);
        t.deepEqual(assistantToolCall.reasoning_details, [
            {
                type: 'reasoning.text',
                text: 'step1',
                format: 'google-gemini-v1',
                index: 0,
            },
            {
                id: 'tool_shell_1',
                type: 'reasoning.encrypted',
                data: 'ENC',
                format: 'google-gemini-v1',
                index: 1,
            },
        ]);
    },
);

test.serial(
    'stores reasoning_details/reasoning on message output items for future turns',
    async t => {
        globalThis.fetch = async (_url, options: any) => {
            JSON.parse(options.body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [
                    {
                        message: {
                            content: 'Hello back',
                            reasoning: 'Some thinking',
                            reasoning_details: [
                                {
                                    type: 'reasoning.text',
                                    text: 'step1',
                                    format: null,
                                    index: 0,
                                },
                            ],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });
        const resp = await model.getResponse({
            systemInstructions: 'system message',
            input: 'hi',
        } as any);

        const msg = resp.output.find(
            (o): o is ExtendedMessageItem => o.type === 'message',
        );
        t.truthy(msg);
        t.is(getContentText(msg), 'Hello back');
        t.is(msg?.reasoning, 'Some thinking');
        t.deepEqual(msg?.reasoning_details, [
            {type: 'reasoning.text', text: 'step1', format: null, index: 0},
        ]);
    },
);

test.serial(
    'passes through full reasoning request object (max_tokens/exclude) even without reasoningEffort',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-reasoning-obj',
                choices: [{message: {content: 'ok'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });
        await model.getResponse({
            systemInstructions: 'system message',
            input: 'hi',
            modelSettings: {
                reasoning: {
                    max_tokens: 2000,
                    exclude: false,
                },
            },
        } as any);

        t.truthy(requests[0]);
        t.deepEqual(requests[0].reasoning, {max_tokens: 2000, exclude: false});
    },
);

test.serial(
    'streams reasoning details and stores assistant history',
    async t => {
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

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });
        const streamedEvents: any[] = [];

        for await (const event of model.getStreamedResponse({
            systemInstructions: 'system message',
            input: 'Streaming input',
        } as any)) {
            streamedEvents.push(event);
        }

        const doneEvent = streamedEvents.find(
            event => event.type === 'response_done',
        );
        t.truthy(doneEvent);

        // First output item should be reasoning
        const reasoningOutput = doneEvent.response.output[0];
        t.is(reasoningOutput.type, 'reasoning');
        t.is(reasoningOutput.content[0].text, 'step1');
        t.is(reasoningOutput.providerData.type, 'reasoning.text');

        // Second output item should be the message
        t.is(doneEvent.response.output[1].content[0].text, 'Hello!');
    },
);

test.serial('converts user message items in array inputs', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return new Response(
            JSON.stringify({choices: [{message: {content: 'ok'}}], usage: {}}),
            {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            },
        );
    };

    const model = new OpenRouterModel({
        settingsService: mockSettingsService,
        loggingService: logger,
        modelId: 'mock-model',
    });

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
                        content:
                            '1 + 1 equals 2.\n\nThis is the fundamental rule of addition in basic arithmetic, where adding 1 to 1 results in 2. For example, if you have one apple and get one more, you have two apples.',
                        reasoning:
                            'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                        reasoning_details: [
                            {
                                format: 'xai-responses-v1',
                                index: 0,
                                type: 'reasoning.summary',
                                summary:
                                    'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                            },
                        ],
                    },
                },
            ],
            usage: {prompt_tokens: 10, completion_tokens: 50, total_tokens: 60},
        });
    };

    const model = new OpenRouterModel({
        settingsService: mockSettingsService,
        loggingService: logger,
        modelId: 'mock-model',
    });
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'What is 1 + 1',
    } as any);

    // Should have two output items: reasoning and message
    t.is(response.output.length, 2);

    // First item should be summary reasoning
    const reasoningOutput = response.output[0] as ReasoningItem;
    t.is(reasoningOutput.type, 'reasoning');
    t.is(reasoningOutput.content.length, 1);
    t.is(reasoningOutput.content[0].type, 'input_text');
    t.is(
        reasoningOutput.content[0].text,
        'First, the user asked "What is 1 + 1", which is a simple math question.\n',
    );
    t.is(reasoningOutput.providerData?.type, 'reasoning.summary');
    t.is(reasoningOutput.providerData?.format, 'xai-responses-v1');
    t.is(
        reasoningOutput.providerData?.summary,
        'First, the user asked "What is 1 + 1", which is a simple math question.\n',
    );

    // Second item should be the message
    const messageOutput = response.output[1] as AssistantMessageItem;
    t.is(messageOutput.type, 'message');
    t.truthy(getContentText(messageOutput)?.includes('1 + 1 equals 2'));
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

    const model = new OpenRouterModel({
        settingsService: mockSettingsService,
        loggingService: logger,
        modelId: 'mock-model',
    });
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'Test encrypted reasoning',
    } as any);

    // Should have two output items: reasoning and message
    t.is(response.output.length, 2);

    // First item should be encrypted reasoning
    const reasoningOutput = response.output[0] as ReasoningItem;
    t.is(reasoningOutput.type, 'reasoning');
    t.deepEqual(reasoningOutput.content, []); // No displayable content for encrypted
    t.is(reasoningOutput.providerData?.type, 'reasoning.encrypted');
    t.is(
        reasoningOutput.providerData?.id,
        'rs_05c9be144fb3fa3b016936cb941e48819183e63b141a094cac',
    );
    t.is(reasoningOutput.providerData?.format, 'openai-responses-v1');
    t.is(reasoningOutput.providerData?.data, 'gAAAAABpNsuVfXBOvLwub1...');

    // Second item should be the message
    const messageOutput = response.output[1] as AssistantMessageItem;
    t.is(messageOutput.type, 'message');
    t.is(getContentText(messageOutput), 'Response with encrypted reasoning');
});

test.serial(
    'adds fallback assistant message when response has empty content',
    async t => {
        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            t.truthy(body);
            return createJsonResponse({
                id: 'resp-empty-content',
                choices: [
                    {
                        message: {
                            content: '',
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 0,
                    total_tokens: 1,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        const response = await model.getResponse({
            systemInstructions: 'system message',
            input: 'Hello?',
        } as any);

        t.is(response.output.length, 1);
        const messageOutput = response.output[0] as AssistantMessageItem;
        t.is(messageOutput.type, 'message');
        t.is(getContentText(messageOutput), 'No response from model.');
    },
);

test.serial(
    'correctly converts function_call_output to tool message',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'ok'}}],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

        // Simulate a conversation turn with function_call_output
        const inputItems = [
            {type: 'input_text', text: 'User message'},
            {
                type: 'function_call',
                id: 'call-abc',
                name: 'search_replace',
                arguments:
                    '{"path":"test.txt","search_content":"old","replace_content":"new"}',
            },
            {
                rawItem: {
                    type: 'function_call_output',
                    callId: 'call-abc',
                    id: 'call-abc',
                    name: 'search_replace',
                    output: '{"output":[{"success":true}]}',
                },
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
    },
);

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
                        content:
                            '1 + 1 equals 2.\n\nThis is the fundamental rule of addition.',
                        reasoning:
                            'First, the user asked "What is 1 + 1", which is a simple math question.\n',
                        reasoning_details: [
                            {
                                format: 'xai-responses-v1',
                                index: 0,
                                type: 'reasoning.summary',
                                summary:
                                    'First, the user asked "What is 1 + 1", which is a simple math question.\n',
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

    const model = new OpenRouterModel({
        settingsService: mockSettingsService,
        loggingService: logger,
        modelId: 'mock-model',
    });
    const response = await model.getResponse({
        systemInstructions: 'system message',
        input: 'What is 1 + 1',
    } as any);

    // Should have three output items: summary reasoning, encrypted reasoning, and message
    t.is(response.output.length, 3);

    // First item should be summary reasoning
    const summaryOutput = response.output[0] as ReasoningItem;
    t.is(summaryOutput.type, 'reasoning');
    t.is(
        summaryOutput.content[0].text,
        'First, the user asked "What is 1 + 1", which is a simple math question.\n',
    );
    t.is(summaryOutput.providerData?.type, 'reasoning.summary');

    // Second item should be encrypted reasoning
    const encryptedOutput = response.output[1] as ReasoningItem;
    t.is(encryptedOutput.type, 'reasoning');
    t.deepEqual(encryptedOutput.content, []); // No displayable content
    t.is(encryptedOutput.providerData?.type, 'reasoning.encrypted');
    t.is(encryptedOutput.providerData?.data, 'zDzBlL2u7sDbq1l6rOpNL');

    // Third item should be the message
    const messageOutput = response.output[2] as AssistantMessageItem;
    t.is(messageOutput.type, 'message');
    t.truthy(getContentText(messageOutput)?.includes('1 + 1 equals 2'));
});

test.serial(
    'applies cache_control to last tool message for Anthropic models',
    async t => {
        const requests: any[] = [];
        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'ok'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        const inputItems = [
            {type: 'input_text', text: 'User message'},
            {
                type: 'function_call',
                id: 'call-1',
                name: 'tool1',
                arguments: '{}',
            },
            {
                type: 'function_call_result',
                callId: 'call-1',
                output: 'result1',
            },
            {
                type: 'function_call',
                id: 'call-2',
                name: 'tool2',
                arguments: '{}',
            },
            {
                type: 'function_call_result',
                callId: 'call-2',
                output: 'result2',
            },
        ];

        await model.getResponse({
            systemInstructions: 'system',
            input: inputItems as any,
        } as any);

        t.truthy(requests[0]);
        const messages = requests[0].messages;

        // Verify last tool message has cache_control
        const lastToolMsg = messages[messages.length - 1];
        t.is(lastToolMsg.role, 'tool');
        t.is(lastToolMsg.tool_call_id, 'call-2');
        t.true(Array.isArray(lastToolMsg.content));
        t.is(lastToolMsg.content[0].text, 'result2');
        t.deepEqual(lastToolMsg.content[0].cache_control, {type: 'ephemeral'});

        // Verify previous tool message does NOT have cache_control
        const firstToolMsg = messages.find(
            (m: any) => m.tool_call_id === 'call-1',
        );
        t.truthy(firstToolMsg);
        t.is(typeof firstToolMsg.content, 'string');
        t.is(firstToolMsg.content, 'result1');
    },
);

test.serial(
    'preserves assistant message content when tool calls are present',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-with-tools',
                choices: [{message: {content: 'Response after tools'}}],
                usage: {
                    prompt_tokens: 5,
                    completion_tokens: 3,
                    total_tokens: 8,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'mock-model',
        });

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
                            function: {
                                name: 'search',
                                arguments: '{"query":"test"}',
                            },
                        },
                    ],
                },
                {
                    type: 'function_call_result',
                    callId: 'call-456',
                    output: 'search results',
                },
            ] as any,
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
    },
);

// ========== Error Recovery Tests: OpenRouterError and Retry Classification ==========

test('OpenRouterError includes status and headers', t => {
    const error = new OpenRouterError(
        'Test error',
        429,
        {'retry-after': '5', 'x-custom': 'value'},
        'response body',
    );

    t.is(error.message, 'Test error');
    t.is(error.status, 429);
    t.deepEqual(error.headers, {'retry-after': '5', 'x-custom': 'value'});
    t.is(error.responseBody, 'response body');
    t.is(error.name, 'OpenRouterError');
});

test('OpenRouterError is throwable', t => {
    const fn = () => {
        throw new OpenRouterError('Error message', 500, {});
    };

    const error = t.throws(fn);
    t.true(error instanceof OpenRouterError);
    if (error instanceof OpenRouterError) {
        t.is(error.status, 500);
    }
});

test('OpenRouterError can be created with minimal arguments', t => {
    const error = new OpenRouterError('Minimal error', 400, {});

    t.is(error.message, 'Minimal error');
    t.is(error.status, 400);
    t.deepEqual(error.headers, {});
    t.is(error.responseBody, undefined);
});

test('OpenRouterError preserves response body', t => {
    const responseBody = '{"error": "Rate limit exceeded"}';
    const error = new OpenRouterError('Rate limited', 429, {}, responseBody);

    t.is(error.responseBody, responseBody);
});

test('OpenRouterError with 429 status for retry logic', t => {
    const error = new OpenRouterError('Too many requests', 429, {
        'retry-after': '60',
    });

    t.is(error.status, 429);
    t.is(error.headers['retry-after'], '60');
});

test('OpenRouterError with 5xx status codes for retry logic', t => {
    const statuses = [500, 502, 503, 504];

    for (const status of statuses) {
        const error = new OpenRouterError(`Server error ${status}`, status, {});
        t.is(error.status, status);
        t.true(error.status >= 500);
    }
});

test('OpenRouterError with 4xx status codes (non-retryable)', t => {
    const statuses = [400, 401, 403, 404, 422];

    for (const status of statuses) {
        const error = new OpenRouterError(`Client error ${status}`, status, {});
        t.is(error.status, status);
        t.true(error.status >= 400 && error.status < 500);
        t.not(error.status, 429); // 429 is retryable
    }
});

test('OpenRouterError with headers for Retry-After extraction', t => {
    const headers = {
        'retry-after': '120',
        'x-ratelimit-reset': '1234567890',
        'content-type': 'application/json',
    };
    const error = new OpenRouterError('Rate limit', 429, headers);

    t.is(error.headers['retry-after'], '120');
    t.is(error.headers['x-ratelimit-reset'], '1234567890');
    t.is(error.headers['content-type'], 'application/json');
});

test('OpenRouterError error instanceof checks', t => {
    const error = new OpenRouterError('Test', 500, {});

    t.true(error instanceof Error);
    t.true(error instanceof OpenRouterError);
});

test('OpenRouterError with empty headers', t => {
    const error = new OpenRouterError('No headers', 503, {});

    t.deepEqual(error.headers, {});
    t.is(Object.keys(error.headers).length, 0);
});

// Anthropic prompt caching tests
test.serial(
    'applies cache_control to system message for Anthropic models',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Hello'}}],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        await model.getResponse({
            systemInstructions: 'You are a helpful assistant.',
            input: 'Hello',
        } as any);

        t.truthy(requests[0]);
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: 'You are a helpful assistant.',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
    },
);

test.serial('applies cache_control for Claude model variants', async t => {
    const requests: any[] = [];

    globalThis.fetch = async (_url, options: any) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return createJsonResponse({
            id: 'resp-1',
            choices: [{message: {content: 'Hello'}}],
            usage: {},
        });
    };

    // Test with different Claude model IDs
    const claudeModels = [
        'anthropic/claude-3-opus',
        'anthropic/claude-3.5-sonnet',
        'anthropic/claude-3-haiku',
        'openrouter/claude-instant',
    ];

    for (const modelId of claudeModels) {
        requests.length = 0;
        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId,
        });

        await model.getResponse({
            systemInstructions: 'System prompt',
            input: 'Test',
        } as any);

        t.truthy(requests[0], `Failed for model: ${modelId}`);
        t.is(requests[0].messages[0].role, 'system');
        t.true(
            Array.isArray(requests[0].messages[0].content),
            `Content should be array for ${modelId}`,
        );
        t.deepEqual(
            requests[0].messages[0].content[0].cache_control,
            {type: 'ephemeral'},
            `cache_control should be set for ${modelId}`,
        );
    }
});

test.serial(
    'does not apply cache_control for non-Anthropic models',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Hello'}}],
                usage: {},
            });
        };

        // Test with non-Anthropic models
        const nonAnthropicModels = [
            'openai/gpt-4o',
            'google/gemini-pro',
            'meta-llama/llama-3-70b',
            'mistralai/mistral-large',
            'openrouter/auto',
        ];

        for (const modelId of nonAnthropicModels) {
            requests.length = 0;
            const model = new OpenRouterModel({
                settingsService: mockSettingsService,
                loggingService: logger,
                modelId,
            });

            await model.getResponse({
                systemInstructions: 'System prompt',
                input: 'Test',
            } as any);

            t.truthy(requests[0], `Failed for model: ${modelId}`);
            t.deepEqual(
                requests[0].messages[0],
                {role: 'system', content: 'System prompt'},
                `System message should be plain string for ${modelId}`,
            );
        }
    },
);

test.serial(
    'applies cache_control in streamed response for Anthropic models',
    async t => {
        const requests: any[] = [];

        // Create a simple SSE stream response
        const sseData = [
            'data: {"id":"resp-1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"resp-1","choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
            'data: [DONE]\n\n',
        ].join('');

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);

            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(sseData));
                    controller.close();
                },
            });

            return new Response(stream, {
                status: 200,
                headers: {'Content-Type': 'text/event-stream'},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        // Consume the stream
        for await (const _event of model.getStreamedResponse({
            systemInstructions: 'You are helpful.',
            input: 'Hi',
        } as any)) {
            // Just consume the events
        }

        t.truthy(requests[0]);
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: 'You are helpful.',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
    },
);

// Tests for last user message caching (using 2 of 4 cache points efficiently)
test.serial(
    'applies cache_control to last user message for Anthropic models (string content)',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Hello'}}],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                },
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        await model.getResponse({
            systemInstructions: 'You are a helpful assistant.',
            input: 'Hello world',
        } as any);

        t.truthy(requests[0]);
        // Verify system message has cache_control
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: 'You are a helpful assistant.',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
        // Verify last user message has cache_control (converted from string to array)
        t.deepEqual(requests[0].messages[1], {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'Hello world',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
    },
);

test.serial(
    'applies cache_control to last user message in multi-turn conversation',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Response'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3-opus',
        });

        // Simulate a multi-turn conversation
        const conversationItems = [
            {type: 'message', role: 'user', content: 'First question'},
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'First answer'}],
                status: 'completed',
            },
            {type: 'message', role: 'user', content: 'Second question'},
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'Second answer'}],
                status: 'completed',
            },
            {type: 'input_text', text: 'Third question'}, // Latest user input
        ];

        await model.getResponse({
            systemInstructions: 'System prompt',
            input: conversationItems as any,
        } as any);

        t.truthy(requests[0]);
        const messages = requests[0].messages;

        // Find all user messages
        const userMessages = messages.filter((m: any) => m.role === 'user');
        t.is(userMessages.length, 3, 'Should have 3 user messages');

        // First two user messages should NOT have cache_control (plain string)
        t.is(
            userMessages[0].content,
            'First question',
            'First user message should be plain string',
        );
        t.is(
            userMessages[1].content,
            'Second question',
            'Second user message should be plain string',
        );

        // Only the LAST user message should have cache_control (array format)
        t.deepEqual(
            userMessages[2],
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Third question',
                        cache_control: {type: 'ephemeral'},
                    },
                ],
            },
            'Last user message should have cache_control',
        );
    },
);

test.serial(
    'does not apply cache_control to user messages for non-Anthropic models',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Hello'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'openai/gpt-4o',
        });

        await model.getResponse({
            systemInstructions: 'System prompt',
            input: 'Hello',
        } as any);

        t.truthy(requests[0]);
        // System message should be plain string for non-Anthropic
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: 'System prompt',
        });
        // User message should also be plain string
        t.deepEqual(requests[0].messages[1], {role: 'user', content: 'Hello'});
    },
);

test.serial(
    'handles conversation with no user messages gracefully for Anthropic models',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Hello'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        // Pass empty input array (edge case)
        await model.getResponse({
            systemInstructions: 'System prompt',
            input: [] as any,
        } as any);

        t.truthy(requests[0]);
        // Should still have system message with cache_control
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: 'System prompt',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
        // Should only have system message, no user messages
        t.is(requests[0].messages.length, 1);
    },
);

test.serial(
    'both system and last user message have cache_control for Anthropic',
    async t => {
        const requests: any[] = [];

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);
            return createJsonResponse({
                id: 'resp-1',
                choices: [{message: {content: 'Response'}}],
                usage: {},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        await model.getResponse({
            systemInstructions: 'You are helpful.',
            input: 'What is 2+2?',
        } as any);

        t.truthy(requests[0]);
        const messages = requests[0].messages;

        // Verify we use exactly 2 cache points: system + last user
        const systemMsg = messages[0];
        const userMsg = messages[1];

        t.is(systemMsg.role, 'system');
        t.truthy(
            systemMsg.content[0].cache_control,
            'System message should have cache_control',
        );
        t.deepEqual(systemMsg.content[0].cache_control, {type: 'ephemeral'});

        t.is(userMsg.role, 'user');
        t.truthy(
            userMsg.content[0].cache_control,
            'Last user message should have cache_control',
        );
        t.deepEqual(userMsg.content[0].cache_control, {type: 'ephemeral'});
    },
);

test.serial(
    'applies cache_control to last user message in streamed response for Anthropic',
    async t => {
        const requests: any[] = [];

        const sseData = [
            'data: {"id":"resp-1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"resp-1","choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
            'data: [DONE]\n\n',
        ].join('');

        globalThis.fetch = async (_url, options: any) => {
            const body = JSON.parse(options.body);
            requests.push(body);

            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(sseData));
                    controller.close();
                },
            });

            return new Response(stream, {
                status: 200,
                headers: {'Content-Type': 'text/event-stream'},
            });
        };

        const model = new OpenRouterModel({
            settingsService: mockSettingsService,
            loggingService: logger,
            modelId: 'anthropic/claude-3.5-sonnet',
        });

        for await (const _event of model.getStreamedResponse({
            systemInstructions: 'You are helpful.',
            input: 'Hi there',
        } as any)) {
            // Consume stream
        }

        t.truthy(requests[0]);
        // Verify both system and user message have cache_control in streamed response
        t.deepEqual(requests[0].messages[0], {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: 'You are helpful.',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
        t.deepEqual(requests[0].messages[1], {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'Hi there',
                    cache_control: {type: 'ephemeral'},
                },
            ],
        });
    },
);
