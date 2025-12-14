import test from 'ava';
import {buildMessagesFromRequest} from './converters.js';
import {LoggingService} from '../../services/logging-service.js';

const logger = new LoggingService({disableLogging: true});

test('merges consecutive assistant messages with tool calls', t => {
    const input = [
        {
            type: 'function_call',
            id: 'call-1',
            name: 'tool1',
            arguments: '{}',
            reasoning_details: [{type: 'reasoning.text', text: 'thinking'}],
        },
        {
            type: 'function_call',
            id: 'call-2',
            name: 'tool2',
            arguments: '{}',
            // Second one might not have reasoning details, or might have them
        }
    ];

    const messages = buildMessagesFromRequest({
        input: input as any,
        tools: [],
    } as any, 'model-id', logger);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'assistant');
    t.is(messages[0].tool_calls.length, 2);
    t.is(messages[0].tool_calls[0].id, 'call-1');
    t.is(messages[0].tool_calls[1].id, 'call-2');
    t.deepEqual(messages[0].reasoning_details, [{type: 'reasoning.text', text: 'thinking'}]);
});

test('merges consecutive assistant messages with tool calls and preserves reasoning from second if first missing', t => {
    const input = [
        {
            type: 'function_call',
            id: 'call-1',
            name: 'tool1',
            arguments: '{}',
        },
        {
            type: 'function_call',
            id: 'call-2',
            name: 'tool2',
            arguments: '{}',
            reasoning_details: [{type: 'reasoning.text', text: 'thinking'}],
        }
    ];

    const messages = buildMessagesFromRequest({
        input: input as any,
        tools: [],
    } as any, 'model-id', logger);

    t.is(messages.length, 1);
    t.is(messages[0].role, 'assistant');
    t.is(messages[0].tool_calls.length, 2);
    t.deepEqual(messages[0].reasoning_details, [{type: 'reasoning.text', text: 'thinking'}]);
});

test('does not merge if intervening message', t => {
    const input = [
        {
            type: 'function_call',
            id: 'call-1',
            name: 'tool1',
            arguments: '{}',
        },
        {
            type: 'function_call_result',
            callId: 'call-1',
            output: 'result',
        },
        {
            type: 'function_call',
            id: 'call-2',
            name: 'tool2',
            arguments: '{}',
        }
    ];

    const messages = buildMessagesFromRequest({
        input: input as any,
        tools: [],
    } as any, 'model-id', logger);

    // Should be: assistant(tool1), tool(result), assistant(tool2)
    t.is(messages.length, 3);
    t.is(messages[0].role, 'assistant');
    t.is(messages[1].role, 'tool');
    t.is(messages[2].role, 'assistant');
});
