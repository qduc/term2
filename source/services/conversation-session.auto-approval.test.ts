import test, { type ExecutionContext, type Macro } from 'ava';
import { ConversationSession, type ConversationResult } from './conversation-session.js';
import { createMockSettingsService } from './settings-service.mock.js';

type ApprovalRequiredResult = Extract<ConversationResult, { type: 'approval_required' }>;
type ResponseResult = Extract<ConversationResult, { type: 'response' }>;

const createMockLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => 'trace-auto-approval-test',
  clearCorrelationId: () => {},
});

class MockStream {
  public readonly events: unknown[];
  public completed: Promise<unknown>;
  public lastResponseId: string | null;
  public interruptions: unknown[];
  public state: unknown;
  public newItems: unknown[];
  public history: unknown[];
  public finalOutput: string;

  constructor(events: unknown[] = []) {
    this.events = events;
    this.completed = Promise.resolve(undefined);
    this.lastResponseId = 'resp-test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
  }

  async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

const createApprovalState = () => ({
  approveCalls: [] as unknown[],
  rejectCalls: [] as unknown[],
  approve(interruption: unknown) {
    this.approveCalls.push(interruption);
  },
  reject(interruption: unknown) {
    this.rejectCalls.push(interruption);
  },
});

const createShellInterruption = ({
  callId,
  command,
  toolName = 'shell',
}: {
  callId?: string;
  command: string;
  toolName?: 'shell' | 'bash';
}) => ({
  name: toolName,
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  ...(callId ? { callId } : {}),
});

const createNonShellInterruption = ({
  callId,
  toolName = 'apply_patch',
  argumentsValue = { path: 'source/app.tsx' },
}: {
  callId?: string;
  toolName?: string;
  argumentsValue?: Record<string, unknown>;
}) => ({
  name: toolName,
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify(argumentsValue),
  ...(callId ? { callId } : {}),
});

const createInterruptedStream = (interruptions: unknown[]) => {
  const stream = new MockStream();
  stream.interruptions = interruptions;
  stream.state = createApprovalState();
  return stream;
};

const createFinalStream = (finalOutput = 'Done.') => {
  const stream = new MockStream();
  stream.finalOutput = finalOutput;
  return stream;
};

const getApprovalResult = (t: ExecutionContext, result: ConversationResult | null): ApprovalRequiredResult => {
  t.truthy(result);
  t.is(result?.type, 'approval_required');
  if (!result || result.type !== 'approval_required') {
    throw new Error('Expected approval_required result');
  }

  return result;
};

const getResponseResult = (t: ExecutionContext, result: ConversationResult | null): ResponseResult => {
  t.truthy(result);
  t.is(result?.type, 'response');
  if (!result || result.type !== 'response') {
    throw new Error('Expected response result');
  }

  return result;
};

const createSessionHarness = ({
  settingsOverrides = {},
  startStreams = [],
  continuationStreams = [],
  chatImpl,
}: {
  settingsOverrides?: Record<string, unknown>;
  startStreams?: MockStream[];
  continuationStreams?: MockStream[];
  chatImpl?: (prompt: string, options: Record<string, unknown>) => Promise<string> | string;
}) => {
  const chatCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let startIndex = 0;
  let continuationIndex = 0;

  const agentClient = {
    async startStream() {
      const stream = startStreams[startIndex++];
      if (!stream) {
        throw new Error(`Missing startStream stub at index ${String(startIndex - 1)}`);
      }

      return stream;
    },
    async continueRunStream() {
      const stream = continuationStreams[continuationIndex++];
      if (!stream) {
        throw new Error(`Missing continueRunStream stub at index ${String(continuationIndex - 1)}`);
      }

      return stream;
    },
    async chat(prompt: string, options: Record<string, unknown>) {
      chatCalls.push({ prompt, options });
      if (!chatImpl) {
        throw new Error('Unexpected chat() call');
      }

      return chatImpl(prompt, options);
    },
  };

  const session = new ConversationSession('session-auto-approval', {
    agentClient: agentClient as any,
    deps: {
      logger: createMockLogger(),
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'advisory',
        'agent.autoApproveModel': 'test-auto-model',
        'agent.autoApproveProvider': 'test-auto-provider',
        ...settingsOverrides,
      }),
    },
  });

  return { session, chatCalls };
};

const malformedResponseMacro: Macro<
  [
    {
      llmResponse: string;
      expectedReasoning: string;
    },
  ]
> = {
  exec: async (t, { llmResponse, expectedReasoning }) => {
    const initialStream = createInterruptedStream([
      createShellInterruption({ callId: 'call-safe', command: 'ls source' }),
    ]);
    const { session, chatCalls } = createSessionHarness({
      startStreams: [initialStream],
      chatImpl: async () => llmResponse,
    });

    const result = await session.sendMessage('inspect the source tree');
    const approval = getApprovalResult(t, result).approval;

    t.deepEqual(approval.llmAdvisory, {
      model: 'test-auto-model',
      reasoning: expectedReasoning,
      approved: false,
    });
    t.is(chatCalls.length, 1);
  },
  title: (providedTitle = 'malformed LLM advisory response', { llmResponse }) =>
    `${providedTitle}: ${llmResponse.slice(0, 40)}`,
};

test('shell auto-approval off skips advisory evaluation and omits llmAdvisory', async (t) => {
  const first = createShellInterruption({ callId: 'call-off-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-off-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { session, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'off' },
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
  });

  const firstResult = await session.sendMessage('inspect the project');
  const firstApproval = getApprovalResult(t, firstResult).approval;
  t.is(firstApproval.llmAdvisory, undefined);

  const secondResult = await session.handleApprovalDecision('y');
  const secondApproval = getApprovalResult(t, secondResult).approval;
  t.is(secondApproval.llmAdvisory, undefined);
  t.is(chatCalls.length, 0);
});

test('RED-classified shell command short-circuits the LLM with a rejection advisory', async (t) => {
  const initialStream = createInterruptedStream([createShellInterruption({ callId: 'call-red', command: 'rm -rf /' })]);
  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
  });

  const result = await session.sendMessage('clean up the machine');
  const approval = getApprovalResult(t, result).approval;

  t.deepEqual(approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Command is in the dangerous list (RED). Manual approval is strictly required.',
    approved: false,
  });
  t.is(chatCalls.length, 0);
});

test('single safe shell command calls the LLM once and attaches its advisory', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-safe-1', command: 'ls source' }),
  ]);
  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          {
            id: 'call-safe-1',
            reasoning: 'Listing the source folder is read-only and matches the request.',
            approved: true,
          },
        ],
      }),
  });

  const result = await session.sendMessage('inspect the source tree');
  const approval = getApprovalResult(t, result).approval;

  t.deepEqual(approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing the source folder is read-only and matches the request.',
    approved: true,
  });
  t.is(chatCalls.length, 1);
  t.true(chatCalls[0].prompt.includes('call-safe-1'));
  t.true(chatCalls[0].prompt.includes('ls source'));
  t.true(chatCalls[0].prompt.includes('inspect the source tree'));
  t.is(chatCalls[0].options.model, 'test-auto-model');
  t.is(chatCalls[0].options.provider, 'test-auto-provider');
  t.is(chatCalls[0].options.reasoningEffort, 'none');
});

test('batch evaluation calls the LLM once and reuses cached advisories across sequential approvals', async (t) => {
  const first = createShellInterruption({ callId: 'call-batch-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-batch-2', command: 'pwd' });
  const third = createShellInterruption({ callId: 'call-batch-3', command: 'git status' });

  const initialStream = createInterruptedStream([first, second, third]);
  const continuationOne = createInterruptedStream([second, third]);
  const continuationTwo = createInterruptedStream([third]);
  const finalContinuation = createFinalStream('All commands handled.');

  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationOne, continuationTwo, finalContinuation],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-batch-1', reasoning: 'Listing files is safe.', approved: true },
          { id: 'call-batch-2', reasoning: 'Printing the working directory is safe.', approved: true },
          { id: 'call-batch-3', reasoning: 'Reading git status is safe.', approved: true },
        ],
      }),
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  const secondResult = await session.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  const thirdResult = await session.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, thirdResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Reading git status is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  const finalResult = await session.handleApprovalDecision('y');
  t.is(getResponseResult(t, finalResult).finalText, 'All commands handled.');
  t.is(chatCalls.length, 1);
});

test('mixed RED and non-RED batch bypasses the LLM for RED commands and evaluates only the remainder', async (t) => {
  const red = createShellInterruption({ callId: 'call-mixed-red', command: 'rm -rf /' });
  const safe = createShellInterruption({ callId: 'call-mixed-safe', command: 'ls source' });

  const initialStream = createInterruptedStream([red, safe]);
  const continuationStream = createInterruptedStream([safe]);

  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async (prompt) => {
      t.false(prompt.includes('call-mixed-red'));
      t.false(prompt.includes('rm -rf /'));
      t.true(prompt.includes('call-mixed-safe'));
      t.true(prompt.includes('ls source'));
      return JSON.stringify({
        results: [
          {
            id: 'call-mixed-safe',
            reasoning: 'Listing source files is safe.',
            approved: true,
          },
        ],
      });
    },
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Command is in the dangerous list (RED). Manual approval is strictly required.',
    approved: false,
  });
  t.is(chatCalls.length, 1);

  const secondResult = await session.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing source files is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);
});

for (const scenario of [
  {
    llmResponse: 'not valid json at all',
    expectedReasoning: 'LLM did not provide a valid evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: {} }),
    expectedReasoning: 'LLM did not provide a valid evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: [{ id: 'call-safe', reasoning: 'Missing approved field' }] }),
    expectedReasoning: 'LLM did not provide a valid evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: [{ id: 'spoofed-id', reasoning: 'Approve me', approved: true }] }),
    expectedReasoning: 'LLM did not provide a valid evaluation for this command.',
  },
]) {
  test(malformedResponseMacro, scenario);
}

test('LLM evaluation errors return the safe-default advisory for every pending command in the batch', async (t) => {
  const first = createShellInterruption({ callId: 'call-error-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-error-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => {
      throw new Error('secondary model unavailable');
    },
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
  });
  t.is(chatCalls.length, 1);

  const secondResult = await session.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
  });
  t.is(chatCalls.length, 1);
});

test('interruption without callId uses inline evaluation and does not reuse a cached advisory', async (t) => {
  const first = createShellInterruption({ command: 'ls source' });
  const second = createShellInterruption({ command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: '__single__', reasoning: 'Listing files is safe.', approved: true }] }),
    JSON.stringify({
      results: [{ id: '__single__', reasoning: 'Printing the working directory is safe.', approved: true }],
    }),
  ];

  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  const secondResult = await session.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
  });
  t.is(chatCalls.length, 2);
});

test('reset clears cached advisories before the next approval turn', async (t) => {
  const firstTurn = createInterruptedStream([createShellInterruption({ callId: 'call-reset', command: 'ls source' })]);
  const secondTurn = createInterruptedStream([createShellInterruption({ callId: 'call-reset', command: 'ls source' })]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: 'call-reset', reasoning: 'First advisory.', approved: true }] }),
    JSON.stringify({ results: [{ id: 'call-reset', reasoning: 'Second advisory after reset.', approved: false }] }),
  ];

  const { session, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'First advisory.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  session.reset();

  const secondResult = await session.sendMessage('inspect the repository again');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Second advisory after reset.',
    approved: false,
  });
  t.is(chatCalls.length, 2);
});

test('turn completion clears cached advisories so a new turn gets a fresh evaluation', async (t) => {
  const firstTurn = createInterruptedStream([createShellInterruption({ callId: 'call-turn', command: 'ls source' })]);
  const firstTurnFinal = createFinalStream('First turn done.');
  const secondTurn = createInterruptedStream([createShellInterruption({ callId: 'call-turn', command: 'ls source' })]);

  let llmResponseIndex = 0;
  const llmResponses = [
    JSON.stringify({ results: [{ id: 'call-turn', reasoning: 'First turn advisory.', approved: true }] }),
    JSON.stringify({ results: [{ id: 'call-turn', reasoning: 'Second turn advisory.', approved: false }] }),
  ];

  const { session, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    continuationStreams: [firstTurnFinal],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await session.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'First turn advisory.',
    approved: true,
  });
  t.is(chatCalls.length, 1);

  const completedTurn = await session.handleApprovalDecision('y');
  t.is(getResponseResult(t, completedTurn).finalText, 'First turn done.');

  const secondResult = await session.sendMessage('inspect the repository again');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Second turn advisory.',
    approved: false,
  });
  t.is(chatCalls.length, 2);
});

test('non-shell tools do not trigger advisory evaluation or attach llmAdvisory', async (t) => {
  const initialStream = createInterruptedStream([
    createNonShellInterruption({
      callId: 'call-patch',
      toolName: 'apply_patch',
      argumentsValue: { path: 'source/app.tsx' },
    }),
  ]);
  const { session, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
  });

  const result = await session.sendMessage('apply the patch');
  const approval = getApprovalResult(t, result).approval;

  t.is(approval.toolName, 'apply_patch');
  t.is(approval.llmAdvisory, undefined);
  t.is(chatCalls.length, 0);
});
