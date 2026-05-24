import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { ConversationService } from './conversation-service.js';

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
  events: any[];
  completed: Promise<void>;
  lastResponseId: string;
  interruptions: any[];
  state: any;
  newItems: any[];
  history: any[];
  finalOutput: string;

  constructor(events: any[]) {
    this.events = events;
    this.completed = Promise.resolve();
    this.lastResponseId = 'resp_test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any, void, unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

test('integration: streamed response emits deltas and final output', async (t) => {
  const stream = new MockStream([
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
  ]);
  stream.finalOutput = 'Hello world';

  const service = new ConversationService({
    agentClient: {
      async startStream() {
        return stream;
      },
    } as any,
    deps: { logger: mockLogger as any },
  });

  const chunks: Array<{ full: string; chunk: string }> = [];
  const events: string[] = [];
  const result = await service.sendMessage('hi', {
    onTextChunk(full, chunk) {
      chunks.push({ full, chunk });
    },
    onEvent(event) {
      events.push(event.type);
    },
  });

  t.deepEqual(chunks, [
    { full: 'Hello', chunk: 'Hello' },
    { full: 'Hello world', chunk: ' world' },
  ]);
  t.deepEqual(events, ['text_delta', 'text_delta', 'final']);
  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.is(result.finalText, 'Hello world');
  }
});

test('integration: approval round-trip (approval_required -> continue -> final)', async (t) => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-approval-1',
  };

  const approvalState = {
    approved: [] as any[],
    rejected: [] as any[],
    approve(arg: any) {
      this.approved.push(arg);
    },
    reject(arg: any) {
      this.rejected.push(arg);
    },
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = approvalState;
  initialStream.lastResponseId = 'resp-before-approval';

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';
  continuationStream.lastResponseId = 'resp-after-approval';

  let continueOptions: any = null;
  const service = new ConversationService({
    agentClient: {
      async startStream() {
        return initialStream;
      },
      async continueRunStream(state: any, options: any) {
        t.is(state, approvalState);
        continueOptions = options;
        return continuationStream;
      },
    } as any,
    deps: { logger: mockLogger as any },
  });

  const first = await service.sendMessage('run command');
  t.is(first.type, 'approval_required');
  if (first.type === 'approval_required') {
    t.is(first.approval.toolName, 'shell');
    t.is(first.approval.argumentsText, 'echo hi');
  }

  const final = await service.handleApprovalDecision('y');
  t.truthy(final);
  t.is(final?.type, 'response');
  t.is(final?.type === 'response' ? final.finalText : '', 'Approved run');
  t.deepEqual(approvalState.approved, [interruption]);
  t.deepEqual(approvalState.rejected, []);
  t.deepEqual(continueOptions, { previousResponseId: 'resp-before-approval' });
});

test('integration: hallucination retry retries once and succeeds', async (t) => {
  let startCalls = 0;
  const successfulStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Retried successfully' }]);
  successfulStream.finalOutput = 'Retried successfully';

  const emittedEvents: string[] = [];
  const service = new ConversationService({
    agentClient: {
      async startStream() {
        startCalls++;
        if (startCalls === 1) {
          throw new ModelBehaviorError('Tool imaginary_tool not found in agent Terminal Assistant.');
        }
        return successfulStream;
      },
    } as any,
    deps: { logger: mockLogger as any },
  });

  const result = await service.sendMessage('do something', {
    onEvent(event) {
      emittedEvents.push(event.type);
    },
  });

  t.is(startCalls, 2);
  t.true(emittedEvents.includes('retry'));
  t.true(emittedEvents.includes('final'));
  t.is(result.type, 'response');
  if (result.type === 'response') {
    t.is(result.finalText, 'Retried successfully');
  }
});
