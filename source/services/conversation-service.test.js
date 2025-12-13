import test from 'ava';
import {ConversationService} from '../../dist/services/conversation-service.js';
import {
    clearApprovalRejectionMarkers,
    markToolCallAsApprovalRejection,
} from '../../dist/utils/extract-command-messages.js';

const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => {},
    clearCorrelationId: () => {},
};

class MockStream {
    constructor(events) {
        this.events = events;
        this.completed = Promise.resolve();
        this.lastResponseId = 'resp_test';
        this.interruptions = [];
        this.state = {};
        this.newItems = [];
        this.history = [];
        this.finalOutput = '';
    }

    async *[Symbol.asyncIterator]() {
        for (const event of this.events) {
            yield event;
        }
    }
}

test.beforeEach(() => {
    clearApprovalRejectionMarkers();
});

test('emits live text chunks for response.output_text.delta events', async t => {
    t.plan(3);

    const events = [
        {type: 'response.output_text.delta', delta: 'Hello'},
        {type: 'response.output_text.delta', delta: ' world'},
    ];

    const mockClient = {
        async startStream() {
            return new MockStream(events);
        },
    };

    const chunks = [];
    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('hi', {
        onTextChunk(full, chunk) {
            chunks.push({full, chunk});
        },
    });

    t.deepEqual(chunks, [
        {full: 'Hello', chunk: 'Hello'},
        {full: 'Hello world', chunk: ' world'},
    ]);
    t.is(result.type, 'response');
    t.is(result.finalText, 'Hello world');
});

test('emits ConversationEvents (text_delta → final) in order', async t => {
    const events = [
        {type: 'response.output_text.delta', delta: 'Hello'},
        {type: 'response.output_text.delta', delta: ' world'},
    ];

    const mockClient = {
        async startStream() {
            return new MockStream(events);
        },
    };

    const emitted = [];
    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('hi', {
        onEvent(event) {
            emitted.push(event);
        },
    });

    t.is(result.type, 'response');
    t.is(result.finalText, 'Hello world');
    t.deepEqual(
        emitted.map(e => e.type),
        ['text_delta', 'text_delta', 'final'],
    );
});

test('emits approval_required ConversationEvent for interruptions', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
        callId: 'call-xyz',
    };

    const initialStream = new MockStream([]);
    initialStream.interruptions = [interruption];

    const mockClient = {
        async startStream() {
            return initialStream;
        },
    };

    const emitted = [];
    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('run command', {
        onEvent(event) {
            emitted.push(event);
        },
    });

    t.is(result.type, 'approval_required');
    t.is(emitted.length, 1);
    t.is(emitted[0].type, 'approval_required');
    t.is(emitted[0].approval.toolName, 'bash');
    t.is(emitted[0].approval.argumentsText, 'echo hi');
    t.is(emitted[0].approval.callId, 'call-xyz');
});

test('emits events when resolving aborted approval on next message', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
        callId: 'call-abort',
    };

    const initialStream = new MockStream([]);
    initialStream.interruptions = [interruption];
    initialStream.state = {
        approveCalls: [],
        rejectCalls: [],
        approve(arg) {
            this.approveCalls.push(arg);
        },
        reject(arg) {
            this.rejectCalls.push(arg);
        },
    };

    const continuationStream = new MockStream([
        {type: 'response.output_text.delta', delta: 'After abort'},
    ]);
    continuationStream.finalOutput = 'After abort';

    let interceptorCount = 0;
    const mockClient = {
        abort() {},
        addToolInterceptor() {
            interceptorCount++;
            return () => {
                interceptorCount--;
            };
        },
        async startStream() {
            return initialStream;
        },
        async continueRunStream(state, options) {
            t.is(state, initialStream.state);
            t.deepEqual(options, {previousResponseId: 'resp_test'});
            return continuationStream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});

    const approvalEvents = [];
    const approvalResult = await service.sendMessage('run command', {
        onEvent(event) {
            approvalEvents.push(event);
        },
    });
    t.is(approvalResult.type, 'approval_required');
    t.is(approvalEvents[0].type, 'approval_required');

    service.abort();

    const resolvedEvents = [];
    const resolvedResult = await service.sendMessage('new input', {
        onEvent(event) {
            resolvedEvents.push(event);
        },
    });

    t.is(resolvedResult.type, 'response');
    t.is(resolvedResult.finalText, 'After abort');
    t.true(resolvedEvents.some(e => e.type === 'text_delta'));
    t.true(resolvedEvents.some(e => e.type === 'final'));
    t.is(interceptorCount, 0);
    t.deepEqual(initialStream.state.approveCalls, [interruption]);
});

test('passes previous response ids into subsequent runs', async t => {
    const streams = [new MockStream([]), new MockStream([])];
    streams[0].lastResponseId = 'resp-1';
    streams[0].finalOutput = 'First run done.';
    streams[1].lastResponseId = 'resp-2';
    streams[1].finalOutput = 'Second run done.';

    const startCalls = [];
    const mockClient = {
        async startStream(text, options) {
            const index = startCalls.length;
            startCalls.push({text, options});
            return streams[index];
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    await service.sendMessage('first');
    const secondResult = await service.sendMessage('second');

    t.deepEqual(startCalls, [
        {text: 'first', options: {previousResponseId: null}},
        {text: 'second', options: {previousResponseId: 'resp-1'}},
    ]);
    t.is(secondResult.type, 'response');
    t.is(secondResult.finalText, 'Second run done.');
});

test('emits approval interruptions and resumes after approval', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
    };

    const initialStream = new MockStream([]);
    initialStream.interruptions = [interruption];
    initialStream.state = {
        approveCalls: [],
        rejectCalls: [],
        approve(arg) {
            this.approveCalls.push(arg);
        },
        reject(arg) {
            this.rejectCalls.push(arg);
        },
    };

    const continuationStream = new MockStream([
        {type: 'response.output_text.delta', delta: 'Approved run'},
    ]);
    continuationStream.finalOutput = 'Approved run';

    const mockClient = {
        async startStream() {
            return initialStream;
        },
        async continueRunStream(state, options) {
            t.is(state, initialStream.state);
            t.deepEqual(options, {previousResponseId: 'resp_test'});
            return continuationStream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const approvalResult = await service.sendMessage('run command');
    t.is(approvalResult.type, 'approval_required');
    t.is(approvalResult.approval.toolName, 'bash');
    t.is(approvalResult.approval.argumentsText, 'echo hi');

    const finalResult = await service.handleApprovalDecision('y');
    t.truthy(finalResult);
    t.is(finalResult.type, 'response');
    t.is(finalResult.finalText, 'Approved run');
    t.deepEqual(initialStream.state.approveCalls, [interruption]);
    t.deepEqual(initialStream.state.rejectCalls, []);
});

test('dedupes command messages emitted live from run events', async t => {
    const commandPayload = 'exit 0\nfile.txt';
    const rawItem = {
        id: 'call-123',
        type: 'function_call_result',
        name: 'shell',
        arguments: JSON.stringify({commands: 'ls'}),
    };
    const commandItem = {
        type: 'tool_call_output_item',
        name: 'shell',
        output: commandPayload,
        rawItem,
    };
    const events = [{type: 'run_item_stream_event', item: commandItem}];
    const stream = new MockStream(events);
    stream.newItems = [commandItem];

    const emitted = [];
    const mockClient = {
        async startStream() {
            return stream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('run shell', {
        onCommandMessage(message) {
            emitted.push(message);
        },
    });

    t.deepEqual(emitted, [
        {
            id: 'call-123-0',
            sender: 'command',
            command: 'ls',
            output: 'file.txt',
            success: true,
            isApprovalRejection: false,
            failureReason: undefined,
        },
    ]);
    t.deepEqual(result.commandMessages, []);
});

test('attaches cached shell args when output uses call_id', async t => {
    const functionCallItem = {
        rawItem: {
            type: 'function_call',
            id: 'call-abc',
            name: 'shell',
            arguments: JSON.stringify({command: 'npm run lint'}),
        },
    };

    const outputItem = {
        type: 'tool_call_output_item',
        name: 'shell',
        output: 'exit 0\n> md-preview@0.0.0 lint\n> eslint .',
        rawItem: {
            type: 'function_call_result',
            name: 'shell',
            id: 'result-1',
            call_id: 'call-abc',
        },
    };

    const events = [
        {type: 'run_item_stream_event', item: functionCallItem},
        {type: 'run_item_stream_event', item: outputItem},
    ];
    const stream = new MockStream(events);
    stream.newItems = [functionCallItem, outputItem];

    const emitted = [];
    const mockClient = {
        async startStream() {
            return stream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('run shell', {
        onCommandMessage(message) {
            emitted.push(message);
        },
    });

    t.deepEqual(emitted, [
        {
            id: 'result-1-0',
            sender: 'command',
            command: 'npm run lint',
            output: '> md-preview@0.0.0 lint\n> eslint .',
            success: true,
            isApprovalRejection: false,
            failureReason: undefined,
        },
    ]);
    t.deepEqual(result.commandMessages, []);
});

test('skips approval rejection command messages', async t => {
    const rejectionPayload = JSON.stringify({
        output: [
            {
                command: 'should-not-show',
                stdout: 'fake output',
                stderr: '',
                outcome: {type: 'exit', exitCode: 1},
            },
        ],
    });
    const rawItem = {
        id: 'rejection-call',
        callId: 'rejection-call',
        type: 'function_call_result',
        name: 'shell',
        arguments: JSON.stringify({commands: ['should-not-show']}),
    };
    markToolCallAsApprovalRejection(rawItem.callId);
    const commandItem = {
        type: 'tool_call_output_item',
        name: 'shell',
        output: rejectionPayload,
        rawItem,
    };
    const events = [{type: 'run_item_stream_event', item: commandItem}];
    const stream = new MockStream(events);
    stream.newItems = [commandItem];

    const emitted = [];
    const mockClient = {
        async startStream() {
            return stream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('run shell', {
        onCommandMessage() {
            emitted.push('called');
        },
    });

    t.deepEqual(emitted, []);
    t.deepEqual(result.commandMessages, []);
});

test('dedupes commands from initial stream when continuation history contains them', async t => {
    // This test simulates the scenario where:
    // 1. Initial stream emits command 'ls' before hitting an approval interruption
    // 2. User approves, continuation stream runs
    // 3. Continuation stream's history/newItems contains the 'ls' command again
    // The 'ls' command should NOT be duplicated in the final result

    const lsCommandPayload = 'exit 0\nfile.txt';
    const lsRawItem = {
        id: 'call-ls-123',
        type: 'function_call_result',
        name: 'shell',
        arguments: JSON.stringify({commands: 'ls'}),
    };
    const lsCommandItem = {
        type: 'tool_call_output_item',
        name: 'shell',
        output: lsCommandPayload,
        rawItem: lsRawItem,
    };

    const sedCommandPayload = 'exit 0\ncontent';
    const sedRawItem = {
        id: 'call-sed-456',
        type: 'function_call_result',
        name: 'shell',
        arguments: JSON.stringify({commands: 'sed -n "1,10p" file.txt'}),
    };
    const sedCommandItem = {
        type: 'tool_call_output_item',
        name: 'shell',
        output: sedCommandPayload,
        rawItem: sedRawItem,
    };

    const interruption = {
        name: 'shell',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({commands: 'sed -n "1,10p" file.txt'}),
    };

    // Initial stream: emits 'ls' command, then hits approval for 'sed'
    const initialEvents = [
        {type: 'run_item_stream_event', item: lsCommandItem},
    ];
    const initialStream = new MockStream(initialEvents);
    initialStream.interruptions = [interruption];
    initialStream.state = {
        approveCalls: [],
        approve(arg) {
            this.approveCalls.push(arg);
        },
        reject() {},
    };

    // Continuation stream: emits 'sed' command, history contains BOTH 'ls' and 'sed'
    const continuationEvents = [
        {type: 'run_item_stream_event', item: sedCommandItem},
    ];
    const continuationStream = new MockStream(continuationEvents);
    continuationStream.finalOutput = 'Done';
    // Simulate that the continuation stream's history contains both commands
    continuationStream.history = [lsCommandItem, sedCommandItem];

    const mockClient = {
        async startStream() {
            return initialStream;
        },
        async continueRunStream() {
            return continuationStream;
        },
    };

    const emittedCommands = [];
    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});

    // Send initial message - should emit 'ls' and return approval_required
    const approvalResult = await service.sendMessage('run commands', {
        onCommandMessage(message) {
            emittedCommands.push(message);
        },
    });

    t.is(approvalResult.type, 'approval_required');
    t.is(emittedCommands.length, 1);
    t.is(emittedCommands[0].id, 'call-ls-123-0');

    // Handle approval - should emit 'sed' but NOT duplicate 'ls'
    const finalResult = await service.handleApprovalDecision('y', undefined, {
        onCommandMessage(message) {
            emittedCommands.push(message);
        },
    });

    t.is(finalResult.type, 'response');
    // Only 'sed' should be emitted during continuation
    t.is(emittedCommands.length, 2);
    t.is(emittedCommands[1].id, 'call-sed-456-0');
    // Final result should have no additional commands since both were emitted live
    t.deepEqual(finalResult.commandMessages, []);
});

test('reset() clears conversation state', async t => {
    const streams = [new MockStream([]), new MockStream([])];
    streams[0].lastResponseId = 'resp-1';

    const startCalls = [];
    const mockClient = {
        async startStream(text, options) {
            startCalls.push({text, options});
            return streams[startCalls.length - 1];
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    await service.sendMessage('first');

    service.reset();

    await service.sendMessage('second');

    t.deepEqual(startCalls[1].options, {previousResponseId: null});
});

test('reset() clears provider conversations when supported', async t => {
    let clearCalls = 0;
    const mockClient = {
        clearConversations() {
            clearCalls++;
        },
        async startStream() {
            return new MockStream([]);
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    await service.sendMessage('first message');

    service.reset();

    t.is(clearCalls, 1);
});

test('setModel() delegates to agent client', t => {
    let setModelCalledWith = null;
    const mockClient = {
        setModel(model) {
            setModelCalledWith = model;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    service.setModel('gpt-4');

    t.is(setModelCalledWith, 'gpt-4');
});

test('setTemperature() delegates to agent client when supported', t => {
    let setTemperatureCalledWith = null;
    const mockClient = {
        setTemperature(value) {
            setTemperatureCalledWith = value;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    service.setTemperature(0.7);

    t.is(setTemperatureCalledWith, 0.7);
});

test('abort() delegates to agent client and clears pending approval', async t => {
    let abortCalled = false;
    const mockClient = {
        abort() {
            abortCalled = true;
        },
        async startStream() {
            const stream = new MockStream([]);
            stream.interruptions = [
                {
                    name: 'bash',
                    agent: {name: 'CLI Agent'},
                    arguments: JSON.stringify({command: 'echo hi'}),
                },
            ];
            return stream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    // Trigger a pending approval
    await service.sendMessage('run command');

    service.abort();

    t.true(abortCalled);

    const result = await service.handleApprovalDecision('y');
    t.is(result, null);
});

test('handleApprovalDecision() rejects interruption when answer is n', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
    };

    const initialStream = new MockStream([]);
    initialStream.interruptions = [interruption];
    initialStream.state = {
        approveCalls: [],
        rejectCalls: [],
        approve(arg) {
            this.approveCalls.push(arg);
        },
        reject(arg) {
            this.rejectCalls.push(arg);
        },
    };

    const continuationStream = new MockStream([
        {type: 'response.output_text.delta', delta: 'Rejected run'},
    ]);
    continuationStream.finalOutput = 'Rejected run';

    const mockClient = {
        async startStream() {
            return initialStream;
        },
        async continueRunStream(state, options) {
            t.deepEqual(options, {previousResponseId: 'resp_test'});
            return continuationStream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    await service.sendMessage('run command');

    const finalResult = await service.handleApprovalDecision('n');

    t.is(finalResult.type, 'response');
    t.deepEqual(initialStream.state.approveCalls, []);
    t.deepEqual(initialStream.state.rejectCalls, [interruption]);
});

test('handleApprovalDecision() returns null when no pending approval', async t => {
    const service = new ConversationService({agentClient: {}, deps: {logger: mockLogger}});
    const result = await service.handleApprovalDecision('y');
    t.is(result, null);
});

test('emits live reasoning chunks', async t => {
    t.plan(3);

    // Reasoning is now streamed via model events carrying reasoning_summary_text deltas
    const events = [
        {
            type: 'response.output_text.delta',
            data: {
                type: 'model',
                event: {
                    type: 'response.reasoning_summary_text.delta',
                    delta: 'Thinking...',
                },
            },
        },
        {
            type: 'response.output_text.delta',
            data: {
                type: 'model',
                event: {
                    type: 'response.reasoning_summary_text.delta',
                    delta: ' Still thinking.',
                },
            },
        },
    ];

    const mockClient = {
        async startStream() {
            return new MockStream(events);
        },
    };

    const chunks = [];
    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('hi', {
        onReasoningChunk(full, chunk) {
            chunks.push({full, chunk});
        },
    });

    t.deepEqual(chunks, [
        {full: 'Thinking...', chunk: 'Thinking...'},
        {full: 'Thinking... Still thinking.', chunk: ' Still thinking.'},
    ]);
    t.is(result.type, 'response');
    t.is(result.reasoningText, 'Thinking... Still thinking.');
});

test('retries on tool hallucination error (ModelBehaviorError)', async t => {
    // Import ModelBehaviorError dynamically
    const {ModelBehaviorError} = await import('@openai/agents');

    let callCount = 0;
    const mockClient = {
        async startStream() {
            callCount++;
            if (callCount === 1) {
                // First call: model hallucinates a non-existent tool
                throw new ModelBehaviorError('Tool open_file not found in agent Terminal Assistant.');
            }
            // Second call: succeeds
            const stream = new MockStream([
                {type: 'response.output_text.delta', delta: 'Retried successfully'},
            ]);
            stream.finalOutput = 'Retried successfully';
            return stream;
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});
    const result = await service.sendMessage('explain this file');

    // Should have retried and succeeded on second attempt
    t.is(callCount, 2);
    t.is(result.type, 'response');
    t.is(result.finalText, 'Retried successfully');
});

test('stops retrying after max hallucination retries', async t => {
    const {ModelBehaviorError} = await import('@openai/agents');

    let callCount = 0;
    const mockClient = {
        async startStream() {
            callCount++;
            // Always throw hallucination error
            throw new ModelBehaviorError('Tool fake_tool not found in agent Test Agent.');
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});

    try {
        await service.sendMessage('test message');
        t.fail('Should have thrown error after max retries');
    } catch (error) {
        t.true(error instanceof ModelBehaviorError);
        // Should have tried: initial + 2 retries = 3 total attempts
        t.is(callCount, 3);
    }
});

test('does not retry on non-hallucination ModelBehaviorError', async t => {
    const {ModelBehaviorError} = await import('@openai/agents');

    let callCount = 0;
    const mockClient = {
        async startStream() {
            callCount++;
            // Throw a different kind of ModelBehaviorError
            throw new ModelBehaviorError('Model violated safety guidelines');
        },
    };

    const service = new ConversationService({agentClient: mockClient, deps: {logger: mockLogger}});

    try {
        await service.sendMessage('test message');
        t.fail('Should have thrown error');
    } catch (error) {
        t.true(error instanceof ModelBehaviorError);
        // Should NOT retry - only 1 call
        t.is(callCount, 1);
    }
});
