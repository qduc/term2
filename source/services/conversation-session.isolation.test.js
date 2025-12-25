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

test('sessions do not share previousResponseId', async t => {
    const streamsByText = {
        A1: new MockStream([]),
        A2: new MockStream([]),
        B1: new MockStream([]),
    };
    streamsByText.A1.lastResponseId = 'resp-A1';
    streamsByText.A1.finalOutput = 'A1 done.';
    streamsByText.B1.lastResponseId = 'resp-B1';
    streamsByText.B1.finalOutput = 'B1 done.';
    streamsByText.A2.lastResponseId = 'resp-A2';
    streamsByText.A2.finalOutput = 'A2 done.';

    const startCalls = [];
    const mockClient = {
        async startStream(text, options) {
            startCalls.push({text, options});
            return streamsByText[text];
        },
    };

    const sessionA = new ConversationSession('A', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });
    const sessionB = new ConversationSession('B', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    await sessionA.sendMessage('A1');
    await sessionB.sendMessage('B1');
    await sessionA.sendMessage('A2');

    t.deepEqual(startCalls, [
        {text: 'A1', options: {previousResponseId: null}},
        {text: 'B1', options: {previousResponseId: null}},
        {text: 'A2', options: {previousResponseId: 'resp-A1'}},
    ]);
});

test('sessions do not share pending approval context', async t => {
    const interruption = {
        name: 'bash',
        agent: {name: 'CLI Agent'},
        arguments: JSON.stringify({command: 'echo hi'}),
    };

    const streamA = new MockStream([]);
    streamA.interruptions = [interruption];
    streamA.state = {
        approveCalls: [],
        rejectCalls: [],
        approve(arg) {
            this.approveCalls.push(arg);
        },
        reject(arg) {
            this.rejectCalls.push(arg);
        },
    };

    const streamB = new MockStream([
        {type: 'response.output_text.delta', delta: 'Hello'},
    ]);
    streamB.finalOutput = 'Hello';
    streamB.lastResponseId = 'resp-B1';

    const continuationA = new MockStream([
        {type: 'response.output_text.delta', delta: 'Approved'},
    ]);
    continuationA.finalOutput = 'Approved';

    const mockClient = {
        async startStream(text) {
            if (text === 'needs approval') return streamA;
            if (text === 'normal') return streamB;
            throw new Error(`Unexpected input: ${text}`);
        },
        async continueRunStream(state) {
            t.is(state, streamA.state);
            return continuationA;
        },
    };

    const sessionA = new ConversationSession('A', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });
    const sessionB = new ConversationSession('B', {
        agentClient: mockClient,
        deps: {logger: mockLogger},
    });

    const approvalResult = await sessionA.sendMessage('needs approval');
    t.is(approvalResult.type, 'approval_required');

    const normalResult = await sessionB.sendMessage('normal');
    t.is(normalResult.type, 'response');
    t.is(normalResult.finalText, 'Hello');

    const bApproval = await sessionB.handleApprovalDecision('y');
    t.is(bApproval, null);

    const aFinal = await sessionA.handleApprovalDecision('y');
    t.is(aFinal.type, 'response');
    t.is(aFinal.finalText, 'Approved');
});
