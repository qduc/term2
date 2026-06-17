import { it, expect } from 'vitest';
import { ModelBehaviorError } from '@openai/agents';
import { ConversationService } from './conversation-service.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

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

it('integration: streamed response emits deltas and final output', async () => {
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
    deps: { logger: mockLogger as any, sessionContextService: createSessionContextService() as any },
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

  expect(chunks).toEqual([
    { full: 'Hello', chunk: 'Hello' },
    { full: 'Hello world', chunk: ' world' },
  ]);
  expect(events).toEqual(['text_delta', 'text_delta', 'final']);
  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.finalText).toBe('Hello world');
  }
});

it('integration: approval round-trip (approval_required -> continue -> final)', async () => {
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
        expect(state).toBe(approvalState);
        continueOptions = options;
        return continuationStream;
      },
    } as any,
    deps: { logger: mockLogger as any, sessionContextService: createSessionContextService() as any },
  });

  const first = await service.sendMessage('run command');
  expect(first.type).toBe('approval_required');
  if (first.type === 'approval_required') {
    expect(first.approval.toolName).toBe('shell');
    expect(first.approval.argumentsText).toBe('echo hi');
  }

  const final = await service.handleApprovalDecision('y');
  expect(final).toBeTruthy();
  expect(final?.type).toBe('response');
  expect(final?.type === 'response' ? final.finalText : '').toBe('Approved run');
  expect(approvalState.approved).toEqual([interruption]);
  expect(approvalState.rejected).toEqual([]);
  expect(continueOptions).toBeTruthy();
  expect(continueOptions.previousResponseId).toBe('resp-before-approval');
  expect(continueOptions.sessionId).toBe('default');
});

it('integration: hallucination retry retries once and succeeds', async () => {
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
    deps: { logger: mockLogger as any, sessionContextService: createSessionContextService() as any },
  });

  const result = await service.sendMessage('do something', {
    onEvent(event) {
      emittedEvents.push(event.type);
    },
  });

  expect(startCalls).toBe(2);
  expect(emittedEvents.includes('retry')).toBe(true);
  expect(emittedEvents.includes('final')).toBe(true);
  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.finalText).toBe('Retried successfully');
  }
});

// Regression: terminal-write gate prevents store writes on interrupted streams.
// The store must NOT contain pending tool call/output from the initial
// interrupted stream; only the completed continuation may write the cumulative
// stream.output once.
it('integration: terminal-write gate prevents store write on interrupted stream; continuation writes cumulative output once', async () => {
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
    deps: { logger: mockLogger as any, sessionContextService: createSessionContextService() as any },
  });

  // Step 1: sendMessage triggers approval
  const first = await service.sendMessage('list files');
  expect(first.type).toBe('approval_required');
  if (first.type === 'approval_required') {
    expect(first.approval.toolName).toBe('shell');
    expect(first.approval.argumentsText).toBe('ls');
  }

  // Step 2: store must NOT contain the initial output.
  // The terminal gate prevented writing because the stream was interrupted.
  const historyAfterInterrupt = service.exportState().history as any[];
  expect(historyAfterInterrupt.length, 'store should have only the user message after interrupted stream').toBe(1);
  expect(historyAfterInterrupt[0].role).toBe('user');
  expect(historyAfterInterrupt[0].content).toBe('list files');

  // Step 3: approve and continue
  const final = await service.handleApprovalDecision('y');
  expect(final).toBeTruthy();
  expect(final?.type).toBe('response');
  expect(final?.type === 'response' ? final.finalText : '').toBe('Here are your files: file1.txt, file2.txt');
  expect(approvalState.approved).toEqual([interruption]);

  // Step 4: store must now contain user message + cumulative output,
  // with no duplicated assistant text items.
  const historyAfterComplete = service.exportState().history as any[];
  const expectedLength = 1 + continuationOutput.length; // user msg + output items
  expect(historyAfterComplete.length, 'store should have user message + cumulative output items').toBe(expectedLength);

  // User message is still first
  expect(historyAfterComplete[0].role).toBe('user');
  expect(historyAfterComplete[0].content).toBe('list files');

  // Collect assistant text items — each should appear exactly once
  const assistantTexts: string[] = [];
  for (let i = 1; i < historyAfterComplete.length; i++) {
    const item = historyAfterComplete[i];
    if (item.role === 'assistant' && Array.isArray(item.content) && item.content[0]?.text) {
      assistantTexts.push(item.content[0].text);
    }
  }
  expect(assistantTexts, 'assistant output texts should appear exactly once, no duplicates').toEqual([
    'I will list files for you.',
    'Here are your files: file1.txt, file2.txt',
  ]);

  // Continuation options must thread previousResponseId from the initial stream
  expect(continueOptions).toBeTruthy();
  expect(continueOptions.previousResponseId).toBe('resp-before-gate');
});
