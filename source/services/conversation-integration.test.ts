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
  output: any[];

  constructor(events: any[]) {
    this.events = events;
    this.completed = Promise.resolve();
    this.lastResponseId = 'resp_test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
    this.output = [];
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
  t.truthy(continueOptions);
  t.is(continueOptions.previousResponseId, 'resp-before-approval');
  t.is(continueOptions.sessionId, 'default');
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

// Regression: terminal-write gate prevents store writes on interrupted streams.
// The store must NOT contain pending tool call/output from the initial
// interrupted stream; only the completed continuation may write the cumulative
// stream.output once.
test('integration: terminal-write gate prevents store write on interrupted stream; continuation writes cumulative output once', async (t) => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'ls' }),
    callId: 'call-terminal-gate-1',
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

  // Initial interrupted stream: has output but also interruptions.
  // The output items simulate what the SDK produces before an approval pause.
  const initialOutput: any[] = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will list files for you.' }],
    },
  ];
  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = approvalState;
  initialStream.lastResponseId = 'resp-before-gate';
  initialStream.output = initialOutput;

  // Continuation stream: cumulative output (includes initial items),
  // no interruptions — terminal.
  const continuationOutput: any[] = [
    ...initialOutput,
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Here are your files: file1.txt, file2.txt' }],
    },
  ];
  const continuationStream = new MockStream([
    { type: 'response.output_text.delta', delta: 'Here are your files: ' },
    { type: 'response.output_text.delta', delta: 'file1.txt, file2.txt' },
  ]);
  continuationStream.finalOutput = 'Here are your files: file1.txt, file2.txt';
  continuationStream.lastResponseId = 'resp-after-gate';
  continuationStream.output = continuationOutput;

  let continueOptions: any = null;
  const service = new ConversationService({
    agentClient: {
      async startStream() {
        return initialStream;
      },
      async continueRunStream(_state: any, options: any) {
        continueOptions = options;
        return continuationStream;
      },
    } as any,
    deps: { logger: mockLogger as any },
  });

  // Step 1: sendMessage triggers approval
  const first = await service.sendMessage('list files');
  t.is(first.type, 'approval_required');
  if (first.type === 'approval_required') {
    t.is(first.approval.toolName, 'shell');
    t.is(first.approval.argumentsText, 'ls');
  }

  // Step 2: store must NOT contain the initial output.
  // The terminal gate prevented writing because the stream was interrupted.
  const historyAfterInterrupt = service.exportState().history as any[];
  t.is(historyAfterInterrupt.length, 1, 'store should have only the user message after interrupted stream');
  t.is(historyAfterInterrupt[0].role, 'user');
  t.is(historyAfterInterrupt[0].content, 'list files');

  // Step 3: approve and continue
  const final = await service.handleApprovalDecision('y');
  t.truthy(final);
  t.is(final?.type, 'response');
  t.is(final?.type === 'response' ? final.finalText : '', 'Here are your files: file1.txt, file2.txt');
  t.deepEqual(approvalState.approved, [interruption]);

  // Step 4: store must now contain user message + cumulative output,
  // with no duplicated assistant text items.
  const historyAfterComplete = service.exportState().history as any[];
  const expectedLength = 1 + continuationOutput.length; // user msg + output items
  t.is(historyAfterComplete.length, expectedLength, 'store should have user message + cumulative output items');

  // User message is still first
  t.is(historyAfterComplete[0].role, 'user');
  t.is(historyAfterComplete[0].content, 'list files');

  // Collect assistant text items — each should appear exactly once
  const assistantTexts: string[] = [];
  for (let i = 1; i < historyAfterComplete.length; i++) {
    const item = historyAfterComplete[i];
    if (item.role === 'assistant' && Array.isArray(item.content) && item.content[0]?.text) {
      assistantTexts.push(item.content[0].text);
    }
  }
  t.deepEqual(
    assistantTexts,
    ['I will list files for you.', 'Here are your files: file1.txt, file2.txt'],
    'assistant output texts should appear exactly once, no duplicates',
  );

  // Continuation options must thread previousResponseId from the initial stream
  t.truthy(continueOptions);
  t.is(continueOptions.previousResponseId, 'resp-before-gate');
});
