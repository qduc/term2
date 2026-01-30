import test from 'ava';
import {
    buildMessagesFromRequest,
    extractFunctionToolsFromRequest,
    normalizeUsage,
} from './converters.js';

// Mock logging service
const mockLoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
};

test('buildMessagesFromRequest - includes system instructions', (t) => {
    const request = {
        systemInstructions: 'You are a helpful assistant',
        input: [],
    };

    const messages = buildMessagesFromRequest(request as any, 'gpt-4o', mockLoggingService);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'system');
    t.is(messages[0].content, 'You are a helpful assistant');
});

test('buildMessagesFromRequest - converts user message', (t) => {
    const request = {
        input: [
            {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Hello' }],
            },
        ],
    };

    const messages = buildMessagesFromRequest(request as any, 'gpt-4o', mockLoggingService);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'user');
    t.is(messages[0].content, 'Hello');
});

test('buildMessagesFromRequest - converts assistant message with string content', (t) => {
    const request = {
        input: [
            {
                type: 'message',
                role: 'assistant',
                content: 'Hello back!',
            },
        ],
    };

    const messages = buildMessagesFromRequest(request as any, 'gpt-4o', mockLoggingService);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'assistant');
    t.is(messages[0].content, 'Hello back!');
});

test('buildMessagesFromRequest - converts function call to tool_calls', (t) => {
    const request = {
        input: [
            {
                type: 'function_call',
                callId: 'call_123',
                name: 'shell',
                arguments: '{"command": "ls"}',
            },
        ],
    };

    const messages = buildMessagesFromRequest(request as any, 'gpt-4o', mockLoggingService);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'assistant');
    t.truthy(messages[0].tool_calls);
    t.is(messages[0].tool_calls!.length, 1);
    t.is(messages[0].tool_calls![0].id, 'call_123');
    t.is(messages[0].tool_calls![0].function.name, 'shell');
    t.is(messages[0].tool_calls![0].function.arguments, '{"command": "ls"}');
});

test('buildMessagesFromRequest - converts function call output to tool message', (t) => {
    const request = {
        input: [
            {
                type: 'function_call',
                callId: 'call_123',
                name: 'shell',
                arguments: '{}',
            },
            {
                type: 'function_call_output',
                callId: 'call_123',
                output: 'file1.txt\nfile2.txt',
            },
        ],
    };

    const messages = buildMessagesFromRequest(request as any, 'gpt-4o', mockLoggingService);

    t.is(messages.length, 2);
    t.is(messages[1].role, 'tool');
    t.is(messages[1].content, 'file1.txt\nfile2.txt');
    t.is(messages[1].tool_call_id, 'call_123');
});

test('extractFunctionToolsFromRequest - extracts function tools', (t) => {
    const request = {
        tools: [
            {
                type: 'function',
                name: 'shell',
                description: 'Execute a shell command',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
            },
            {
                type: 'function',
                name: 'grep',
                description: 'Search files',
                parameters: { type: 'object', properties: {} },
            },
        ],
    };

    const tools = extractFunctionToolsFromRequest(request as any);

    t.is(tools.length, 2);
    t.is(tools[0].function.name, 'shell');
    t.is(tools[0].function.description, 'Execute a shell command');
    t.is(tools[1].function.name, 'grep');
});

test('extractFunctionToolsFromRequest - returns empty array when no tools', (t) => {
    const request = {};
    const tools = extractFunctionToolsFromRequest(request as any);
    t.deepEqual(tools, []);
});

test('extractFunctionToolsFromRequest - filters non-function tools', (t) => {
    const request = {
        tools: [
            { type: 'function', name: 'shell', description: 'test', parameters: {} },
            { type: 'computer', name: 'browser' }, // Should be filtered out
        ],
    };

    const tools = extractFunctionToolsFromRequest(request as any);

    t.is(tools.length, 1);
    t.is(tools[0].function.name, 'shell');
});

test('normalizeUsage - normalizes SDK format', (t) => {
    const usage = {
        input_tokens: 100,
        output_tokens: 50,
    };

    const normalized = normalizeUsage(usage);

    t.is(normalized.inputTokens, 100);
    t.is(normalized.outputTokens, 50);
    t.is(normalized.totalTokens, 150);
});

test('normalizeUsage - normalizes OpenAI format', (t) => {
    const usage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
    };

    const normalized = normalizeUsage(usage);

    t.is(normalized.inputTokens, 100);
    t.is(normalized.outputTokens, 50);
    t.is(normalized.totalTokens, 150);
});

test('normalizeUsage - handles empty usage', (t) => {
    const normalized = normalizeUsage({});

    t.is(normalized.inputTokens, 0);
    t.is(normalized.outputTokens, 0);
    t.is(normalized.totalTokens, 0);
});
