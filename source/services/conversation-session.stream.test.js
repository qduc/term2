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
