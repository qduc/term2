import test from 'ava';
import {ReadableStream} from 'node:stream/web';
import {OpenRouterModel, clearOpenRouterConversations} from './openrouter.js';

const originalFetch = globalThis.fetch;

const createJsonResponse = (body: any) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
    });

test.beforeEach(() => {
    clearOpenRouterConversations();
});

test.afterEach.always(() => {
    clearOpenRouterConversations();
    globalThis.fetch = originalFetch;
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

test.serial('streams reasoning details and stores assistant history', async t => {
    const requests: any[] = [];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    'data: {"id":"resp-stream","choices":[{"delta":{"content":"Hello","reasoning_details":[{"type":"text","text":"step1"}]}}]}\n',
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
    t.is(
        doneEvent.response.output[0].reasoning_details?.[0]?.text,
        'step1',
    );
    t.is(doneEvent.response.output[0].content[0].text, 'Hello!');

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
