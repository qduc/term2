import test, { type ExecutionContext, type Macro } from 'ava';
import { type ConversationEvent } from '../conversation/conversation-events.js';
import { type ConversationResult } from './conversation-session.js';
import { createConversationSession } from './session-factory.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

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

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
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
  const askUserAnswerCalls: Array<{ callId: string; answer: string }> = [];
  let startIndex = 0;
  let continuationIndex = 0;

  const agentClient = {
    setAskUserAnswer(callId: string, answer: string) {
      askUserAnswerCalls.push({ callId, answer });
    },
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

  const bundle = createConversationSession({
    sessionId: 'session-auto-approval',
    agentClient: agentClient as any,
    deps: {
      logger: createMockLogger(),
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'advisory',
        'agent.autoApproveModel': 'test-auto-model',
        'agent.autoApproveProvider': 'test-auto-provider',
        ...settingsOverrides,
      }),
      sessionContextService: createSessionContextService() as any,
    },
  });

  return { session: bundle.session, bundle, chatCalls, askUserAnswerCalls };
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
    const { bundle, chatCalls } = createSessionHarness({
      startStreams: [initialStream],
      chatImpl: async () => llmResponse,
    });

    const result = await bundle.terminalAdapter.sendMessage('inspect the source tree');
    const approval = getApprovalResult(t, result).approval;

    t.deepEqual(approval.llmAdvisory, {
      model: 'test-auto-model',
      reasoning: expectedReasoning,
      approved: false,
      source: 'llm',
    });
    t.is(chatCalls.length, 2);
    t.true(chatCalls[1].prompt.includes('The previous shell auto-approval response was invalid.'));
  },
  title: (providedTitle = 'malformed LLM advisory response', { llmResponse }) =>
    `${providedTitle}: ${llmResponse.slice(0, 40)}`,
};

test('shell auto-approval off skips advisory evaluation and omits llmAdvisory', async (t) => {
  const first = createShellInterruption({ callId: 'call-off-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-off-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'off' },
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the project');
  const firstApproval = getApprovalResult(t, firstResult).approval;
  t.is(firstApproval.llmAdvisory, undefined);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  const secondApproval = getApprovalResult(t, secondResult).approval;
  t.is(secondApproval.llmAdvisory, undefined);
  t.is(chatCalls.length, 0);
});

test('RED-classified shell command includes LLM rationale but remains a system rejection advisory', async (t) => {
  const initialStream = createInterruptedStream([createShellInterruption({ callId: 'call-red', command: 'rm -rf /' })]);
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    chatImpl: async (prompt) => {
      t.true(prompt.includes('rm -rf /'));
      return JSON.stringify({
        results: [
          {
            id: 'call-red',
            reasoning: 'This command recursively deletes files from the filesystem root.',
            approved: false,
          },
        ],
      });
    },
  });

  const result = await bundle.terminalAdapter.sendMessage('clean up the machine');
  const approval = getApprovalResult(t, result).approval;

  const llmAdvisory = approval.llmAdvisory;
  t.truthy(llmAdvisory);
  t.is(llmAdvisory?.approved, false);
  t.is(llmAdvisory?.model, 'test-auto-model');
  t.is(llmAdvisory?.source, 'system');
  t.regex(llmAdvisory?.reasoning ?? '', /Blocked by safety heuristics \(RED\):/);
  t.regex(llmAdvisory?.reasoning ?? '', /Model advisory: This command recursively deletes files/);
  t.is(chatCalls.length, 1);
});

test('single safe shell command calls the LLM once and attaches its advisory', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-safe-1', command: 'ls source' }),
  ]);
  const { bundle, chatCalls } = createSessionHarness({
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

  const result = await bundle.terminalAdapter.sendMessage('inspect the source tree');
  const approval = getApprovalResult(t, result).approval;

  t.deepEqual(approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing the source folder is read-only and matches the request.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);
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

  const { bundle, chatCalls } = createSessionHarness({
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

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  const thirdResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, thirdResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Reading git status is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  const finalResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.is(getResponseResult(t, finalResult).finalText, 'All commands handled.');
  t.is(chatCalls.length, 1);
});

test('handleApprovalDecision forwards approval answers to the ask_user bridge', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-ask-user', command: 'echo awaiting approval' }),
  ]);
  const finalStream = createFinalStream('Approved command completed.');

  const { bundle, askUserAnswerCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [finalStream],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('please continue');
  getApprovalResult(t, firstResult);

  const finalResult = await bundle.terminalAdapter.handleApprovalDecision('y', undefined, {
    approvalAnswer: 'Use option B',
  });
  t.is(getResponseResult(t, finalResult).finalText, 'Approved command completed.');
  t.deepEqual(askUserAnswerCalls, [{ callId: 'call-ask-user', answer: 'Use option B' }]);
});

test('mixed RED and non-RED batch evaluates both while RED remains system rejected', async (t) => {
  const red = createShellInterruption({ callId: 'call-mixed-red', command: 'rm -rf /' });
  const safe = createShellInterruption({ callId: 'call-mixed-safe', command: 'ls source' });

  const initialStream = createInterruptedStream([red, safe]);
  const continuationStream = createInterruptedStream([safe]);

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async (prompt) => {
      t.true(prompt.includes('rm -rf /'));
      t.true(prompt.includes('ls source'));
      return JSON.stringify({
        results: [
          {
            id: 'call-mixed-red',
            reasoning: 'Recursive forced deletion from root is destructive.',
            approved: false,
          },
          {
            id: 'call-mixed-safe',
            reasoning: 'Listing source files is safe.',
            approved: true,
          },
        ],
      });
    },
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  const mixedAdvisory = getApprovalResult(t, firstResult).approval.llmAdvisory;
  t.truthy(mixedAdvisory);
  t.is(mixedAdvisory?.approved, false);
  t.is(mixedAdvisory?.model, 'test-auto-model');
  t.is(mixedAdvisory?.source, 'system');
  t.regex(mixedAdvisory?.reasoning ?? '', /Blocked by safety heuristics \(RED\):/);
  t.regex(mixedAdvisory?.reasoning ?? '', /Model advisory: Recursive forced deletion from root/);
  t.is(chatCalls.length, 1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing source files is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);
});

for (const scenario of [
  {
    llmResponse: 'not valid json at all',
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: {} }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: [{ id: 'call-safe', reasoning: 'Missing approved field' }] }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  },
  {
    llmResponse: JSON.stringify({ results: [] }),
    expectedReasoning: 'LLM did not provide a valid ordered evaluation for this command.',
  },
]) {
  test(malformedResponseMacro, scenario);
}

test('LLM evaluation errors return the safe-default advisory for every pending command in the batch', async (t) => {
  const first = createShellInterruption({ callId: 'call-error-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-error-2', command: 'pwd' });

  const initialStream = createInterruptedStream([first, second]);
  const continuationStream = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => {
      throw new Error('secondary model unavailable');
    },
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
    source: 'llm',
    isError: true,
  });
  t.is(chatCalls.length, 1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'LLM evaluation encountered an error.',
    approved: false,
    source: 'llm',
    isError: true,
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

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
    continuationStreams: [continuationStream],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Listing files is safe.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  const secondResult = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Printing the working directory is safe.',
    approved: true,
    source: 'llm',
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

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'First advisory.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  bundle.stateFacade.reset();

  const secondResult = await bundle.terminalAdapter.sendMessage('inspect the repository again');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Second advisory after reset.',
    approved: false,
    source: 'llm',
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

  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [firstTurn, secondTurn],
    continuationStreams: [firstTurnFinal],
    chatImpl: async () => llmResponses[llmResponseIndex++],
  });

  const firstResult = await bundle.terminalAdapter.sendMessage('inspect the repository');
  t.deepEqual(getApprovalResult(t, firstResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'First turn advisory.',
    approved: true,
    source: 'llm',
  });
  t.is(chatCalls.length, 1);

  const completedTurn = await bundle.terminalAdapter.handleApprovalDecision('y');
  t.is(getResponseResult(t, completedTurn).finalText, 'First turn done.');

  const secondResult = await bundle.terminalAdapter.sendMessage('inspect the repository again');
  t.deepEqual(getApprovalResult(t, secondResult).approval.llmAdvisory, {
    model: 'test-auto-model',
    reasoning: 'Second turn advisory.',
    approved: false,
    source: 'llm',
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
  const { bundle, chatCalls } = createSessionHarness({
    startStreams: [initialStream],
  });

  const result = await bundle.terminalAdapter.sendMessage('apply the patch');
  const approval = getApprovalResult(t, result).approval;

  t.is(approval.toolName, 'apply_patch');
  t.is(approval.llmAdvisory, undefined);
  t.is(chatCalls.length, 0);
});

// Phase 2: Full Auto-Approval tests

test('auto mode: LLM-approved safe command skips approval_required and returns final response', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-1', command: 'ls source' }),
  ]);
  const finalStream = createFinalStream('Files listed.');

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-auto-1', reasoning: 'Listing files is read-only and safe.', approved: true }],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('list the source files');
  t.is(result?.type, 'response');
  if (result?.type !== 'response') throw new Error('Expected response');
  t.is(result.finalText, 'Files listed.');
  t.is(chatCalls.length, 1);
});

test('auto mode: approved continuation emits tool_started before streamed output and final', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-sequence', command: 'ls source' }),
  ]);
  const finalStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Files listed.' }]);
  finalStream.finalOutput = 'Files listed.';

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-auto-sequence', reasoning: 'Listing files is safe.', approved: true }],
      }),
  });

  const events: ConversationEvent[] = [];
  for await (const event of bundle.session.run('list the source files')) {
    events.push(event);
  }

  t.deepEqual(
    events.map((event) =>
      event.type === 'tool_started'
        ? { type: event.type, callId: event.toolCallId, toolName: event.toolName }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
    [
      { type: 'tool_started', callId: 'call-auto-sequence', toolName: 'shell' },
      { type: 'text_delta', text: 'Files listed.' },
      { type: 'final', text: 'Files listed.' },
    ],
  );
});

test('auto mode: LLM-rejected command still prompts user with advisory', async (t) => {
  const initialStream = createInterruptedStream([
    // Use a YELLOW command (not RED) so heuristics pass and the LLM makes the rejection call
    createShellInterruption({ callId: 'call-auto-reject', command: 'git log --all --format="%H"' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          {
            id: 'call-auto-reject',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('run the installer');
  const approval = getApprovalResult(t, result).approval;
  t.is(approval.llmAdvisory?.approved, false);
  t.is(approval.llmAdvisory?.source, 'llm');
  t.is(chatCalls.length, 1);
});

test('auto mode: RED command (source=system) is never auto-approved', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-red', command: 'rm -rf /' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-auto-red', reasoning: 'The model explanation should not auto-approve RED.', approved: true },
        ],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('clean the system');
  const approval = getApprovalResult(t, result).approval;
  t.is(approval.llmAdvisory?.approved, false);
  t.is(approval.llmAdvisory?.source, 'system');
  t.regex(approval.llmAdvisory?.reasoning ?? '', /Model advisory: The model explanation should not auto-approve RED\./);
  t.is(chatCalls.length, 1);
});

test('advisory mode: LLM-approved command still prompts the user (Phase 1 behavior preserved)', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-advisory', command: 'ls source' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'advisory' },
    startStreams: [initialStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-advisory', reasoning: 'Listing files is safe.', approved: true }],
      }),
  });

  const result = await bundle.terminalAdapter.sendMessage('list the source files');
  const approval = getApprovalResult(t, result).approval;
  t.is(approval.llmAdvisory?.approved, true);
  t.is(approval.llmAdvisory?.source, 'llm');
  t.is(chatCalls.length, 1);
});

test('auto mode: batch of two commands — first auto-approved, second triggers prompt when rejected', async (t) => {
  const first = createShellInterruption({ callId: 'call-batch-auto-1', command: 'ls source' });
  // Use a YELLOW (non-RED) command so heuristics pass and LLM makes the rejection call
  const second = createShellInterruption({ callId: 'call-batch-auto-2', command: 'git log --all --format="%H"' });

  const initialStream = createInterruptedStream([first, second]);
  // After first is auto-approved, continuation stream surfaces the second interruption
  const continuationAfterFirst = createInterruptedStream([second]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [continuationAfterFirst],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-batch-auto-1', reasoning: 'Listing files is safe.', approved: true },
          {
            id: 'call-batch-auto-2',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  // First command is auto-approved, continuation hits the second which is rejected by LLM
  const result = await bundle.terminalAdapter.sendMessage('inspect repository and dump history');
  const approval = getApprovalResult(t, result).approval;
  t.is(approval.toolName, 'shell');
  t.is(approval.llmAdvisory?.approved, false);
  t.is(approval.llmAdvisory?.source, 'llm');
  t.is(chatCalls.length, 1);
});

test('auto mode: response usage includes the auto-approved first turn, not just the continuation', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-usage-1', command: 'ls source' }),
  ]);
  (initialStream.state as any).usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

  // The continuation reuses the same live RunState, so its run-state usage
  // accumulator is already cumulative for the whole run (first turn included).
  const finalStream = createFinalStream('Files listed.');
  (finalStream.state as any).usage = { inputTokens: 300, outputTokens: 50, totalTokens: 350 };

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [finalStream],
    chatImpl: async () =>
      JSON.stringify({
        results: [{ id: 'call-usage-1', reasoning: 'Listing files is read-only and safe.', approved: true }],
      }),
  });

  const result = getResponseResult(t, await bundle.terminalAdapter.sendMessage('list the source files'));

  // The auto-approved first turn must be reflected in the reported usage. The
  // SDK run-state accumulator already includes it (300 in / 50 out cumulative);
  // it must be reported verbatim, not added on top of the first turn again.
  t.is(result.usage?.prompt_tokens, 300);
  t.is(result.usage?.completion_tokens, 50);
});

test('auto mode: approval_required usage includes the auto-approved first turn', async (t) => {
  const first = createShellInterruption({ callId: 'call-usage-batch-1', command: 'ls source' });
  const second = createShellInterruption({ callId: 'call-usage-batch-2', command: 'git log --all --format="%H"' });

  const initialStream = createInterruptedStream([first, second]);
  (initialStream.state as any).usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

  // Continuation reuses the same RunState; its accumulator is cumulative and
  // already includes the auto-approved first turn (300 in / 50 out).
  const continuationAfterFirst = createInterruptedStream([second]);
  (continuationAfterFirst.state as any).usage = { inputTokens: 300, outputTokens: 50, totalTokens: 350 };

  const { bundle } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    continuationStreams: [continuationAfterFirst],
    chatImpl: async () =>
      JSON.stringify({
        results: [
          { id: 'call-usage-batch-1', reasoning: 'Listing files is safe.', approved: true },
          {
            id: 'call-usage-batch-2',
            reasoning: 'Dumping all commit hashes is not aligned with the current task.',
            approved: false,
          },
        ],
      }),
  });

  const approvalResult = getApprovalResult(
    t,
    await bundle.terminalAdapter.sendMessage('inspect repository and dump history'),
  );

  t.is(approvalResult.usage?.prompt_tokens, 300);
  t.is(approvalResult.usage?.completion_tokens, 50);
});

test('auto mode: evaluator error falls back to prompt without crashing', async (t) => {
  const initialStream = createInterruptedStream([
    createShellInterruption({ callId: 'call-auto-err', command: 'ls source' }),
  ]);

  const { bundle, chatCalls } = createSessionHarness({
    settingsOverrides: { 'shell.autoApproveMode': 'auto' },
    startStreams: [initialStream],
    chatImpl: async () => {
      throw new Error('model unavailable');
    },
  });

  const result = await bundle.terminalAdapter.sendMessage('list files');
  const approval = getApprovalResult(t, result).approval;
  t.is(approval.llmAdvisory?.approved, false);
  t.is(approval.llmAdvisory?.source, 'llm');
  t.is(chatCalls.length, 1);
});
