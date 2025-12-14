import test from 'ava';
import {ConversationSession} from '../../dist/services/conversation-session.js';

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

test('run() streams ConversationEvents (text_delta → final) in order', async t => {
    const events = [
        {type: 'response.output_text.delta', delta: 'Hello'},
        {type: 'response.output_text.delta', delta: ' world'},
    ];

    const stream = new MockStream(events);
    stream.finalOutput = 'Hello world';
    stream.lastResponseId = 'resp-1';

    const mockClient = {
        async startStream() {
            return stream;
        },
    };

    const session = new ConversationSession('s1', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    const emitted = [];
    for await (const ev of session.run('hi')) {
        emitted.push(ev);
    }

    t.deepEqual(emitted.map(e => e.type), ['text_delta', 'text_delta', 'final']);
    t.is(emitted[0].delta, 'Hello');
    t.is(emitted[0].fullText, 'Hello');
    t.is(emitted[1].delta, ' world');
    t.is(emitted[1].fullText, 'Hello world');
    t.is(emitted[2].finalText, 'Hello world');
});

test('continue() streams events after approval decision', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
        callId: 'call-xyz',
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
        async continueRunStream(state) {
            t.is(state, initialStream.state);
            return continuationStream;
        },
    };

    const session = new ConversationSession('s1', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    const first = [];
    for await (const ev of session.run('run command')) {
        first.push(ev);
    }
    t.is(first.length, 1);
    t.is(first[0].type, 'approval_required');
    t.is(first[0].approval.callId, 'call-xyz');

    const cont = [];
    for await (const ev of session.continue({answer: 'y'})) {
        cont.push(ev);
    }

    t.deepEqual(cont.map(e => e.type), ['text_delta', 'final']);
    t.is(cont[0].delta, 'Approved run');
    t.is(cont[1].finalText, 'Approved run');
});

test('run() sends text for OpenAI provider (server-side state)', async t => {
    const stream = new MockStream([
        {type: 'response.output_text.delta', delta: 'Response'},
    ]);
    stream.finalOutput = 'Response';

    let receivedInput;
    const mockClient = {
        async startStream(input) {
            receivedInput = input;
            return stream;
        },
    };

    const session = new ConversationSession('s1', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    const emitted = [];
    for await (const ev of session.run('Hello')) {
        emitted.push(ev);
    }

    // OpenAI should receive just the text string (no getProvider means default 'openai')
    t.is(typeof receivedInput, 'string');
    t.is(receivedInput, 'Hello');
    t.is(emitted[emitted.length - 1].type, 'final');
});

test('run() sends full history for non-OpenAI providers (client-side state)', async t => {
    const stream = new MockStream([
        {type: 'response.output_text.delta', delta: 'Response'},
    ]);
    stream.finalOutput = 'Response';
    stream.history = [
        {role: 'user', type: 'message', content: 'Hello'},
        {role: 'assistant', type: 'message', content: [{type: 'output_text', text: 'Response'}]},
    ];

    let receivedInput;
    const mockClient = {
        async startStream(input) {
            receivedInput = input;
            return stream;
        },
        getProvider() {
            return 'openrouter'; // Non-OpenAI provider
        },
    };

    const session = new ConversationSession('s1', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    const emitted = [];
    for await (const ev of session.run('Hello')) {
        emitted.push(ev);
    }

    // Non-OpenAI providers should receive full history array
    t.true(Array.isArray(receivedInput));
    t.is(receivedInput.length, 1); // Initial user message
    t.is(receivedInput[0].role, 'user');
    t.is(receivedInput[0].content, 'Hello');
    t.is(emitted[emitted.length - 1].type, 'final');
});

test('run() sends full history for openai-compatible providers', async t => {
    const stream = new MockStream([
        {type: 'response.output_text.delta', delta: 'Response'},
    ]);
    stream.finalOutput = 'Response';
    stream.history = [
        {role: 'user', type: 'message', content: 'First message'},
        {role: 'assistant', type: 'message', content: [{type: 'output_text', text: 'First response'}]},
        {role: 'user', type: 'message', content: 'Second message'},
        {role: 'assistant', type: 'message', content: [{type: 'output_text', text: 'Response'}]},
    ];

    let firstInput, secondInput;
    let callCount = 0;
    const mockClient = {
        async startStream(input) {
            callCount++;
            if (callCount === 1) {
                firstInput = input;
            } else {
                secondInput = input;
            }
            return stream;
        },
        getProvider() {
            return 'deepseek'; // Custom openai-compatible provider
        },
    };

    const session = new ConversationSession('s1', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    // First message
    for await (const ev of session.run('First message')) {
        // consume events
    }

    // OpenAI-compatible provider should receive full history array
    t.true(Array.isArray(firstInput));
    t.is(firstInput.length, 1);
    t.is(firstInput[0].content, 'First message');

    // Second message should contain both previous and new message
    for await (const ev of session.run('Second message')) {
        // consume events
    }

    t.true(Array.isArray(secondInput));
    t.true(secondInput.length >= 2, 'Second call should include conversation history');
});
