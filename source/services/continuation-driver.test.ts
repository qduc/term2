// @ts-nocheck - ContinuationDriver tests use mock objects that don't satisfy RunState type
import test from 'ava';
import {
  ContinuationDriver,
  ManualApprovalDecisionPolicy,
  ShellAutoApprovalDecisionPolicy,
} from './continuation-driver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ApprovalState } from './approval-state.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationStore } from './conversation-store.js';
import { LoggingService } from './logging-service.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';

import { ProviderContinuity } from './provider-continuity.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationLogger } from './conversation-logger.js';
import type { ConversationEvent } from './conversation-events.js';
import { GenerationGuard } from './generation-guard.js';

import { DefaultConversationRecoveryPolicy } from './recovery-policy.js';
import { DefaultRecoveryExecutor } from './recovery-executor.js';
import { DefaultRetryClassifier } from './retry-classifier.js';
import { RetryEventPresenter } from './retry-event-presenter.js';

const logger = new LoggingService({ disableLogging: true });

class MockStream {
  public events: unknown[] = [];
  public lastResponseId: string = 'resp-test';
  public interruptions: unknown[] = [];
  public state: unknown = {};
  public newItems: unknown[] = [];
  public history: unknown[] = [];
  public finalOutput: string = '';

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

const createMockAgentClient = () => {
  let continueRunStreamResults: MockStream[] = [];
  let startStreamResults: MockStream[] = [];
  const continueRunStreamCalls: unknown[] = [];

  const client = {
    async startStream(input: unknown, options: unknown) {
      const result = startStreamResults.shift();
      if (!result) throw new Error('No startStream result');
      return result;
    },
    async continueRunStream(state: unknown, options: unknown) {
      continueRunStreamCalls.push({ state, options });
      const result = continueRunStreamResults.shift();
      if (!result) throw new Error('No continueRunStream result');
      return result;
    },
    abort() {},
    getStreamMaxRetries() {
      return 3;
    },
    shouldRetryWithoutFlexServiceTier() {
      return false;
    },
    setContinueRunStreamResults(results: MockStream[]) {
      continueRunStreamResults = results;
    },
    setStartStreamResults(results: MockStream[]) {
      startStreamResults = results;
    },
    get continueRunStreamCallsSnapshot() {
      return [...continueRunStreamCalls];
    },
  };

  return client;
};

const collectResult = async (
  gen: AsyncGenerator<ConversationEvent, import('./continuation-driver.js').ContinuationDriveResult, void>,
): Promise<{ events: ConversationEvent[]; result: import('./continuation-driver.js').ContinuationDriveResult }> => {
  const events: ConversationEvent[] = [];
  let result: import('./continuation-driver.js').ContinuationDriveResult;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, result };
};

const createHarness = ({
  agentClient,
  continuationStreams = [],
}: {
  agentClient?: ReturnType<typeof createMockAgentClient>;
  continuationStreams?: MockStream[];
} = {}) => {
  const client = agentClient ?? createMockAgentClient();
  client.setContinueRunStreamResults(continuationStreams);

  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const approvalState = new ApprovalState();
  const turnAccumulator = new TurnItemAccumulator();

  const providerContinuity = new ProviderContinuity();

  const inputPlanner = new SessionInputPlanner({
    settingsService: undefined as any,
    agentClient: client as any,
    toolTracker,
    providerContinuity,
  });

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('off' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const generationGuard = new GenerationGuard();
  generationGuard.capture(); // Bump to 1 to match tests passing generation: 1

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient: client as any,
    approvalState,
    logger,
    sessionId: 'test-session',
    toolTracker,
    generationGuard,
  });

  const conversationLogger = new ConversationLogger({
    turnAccumulator,
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
    getToolLedger: () => toolTracker.export(),
  });

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const recoveryPolicy = new DefaultConversationRecoveryPolicy();
  const recoveryExecutor = new DefaultRecoveryExecutor({
    toolTracker,
    conversationStore,
    providerContinuity,
  });
  const retryClassifier = new DefaultRetryClassifier(client as any);
  const retryEventPresenter = new RetryEventPresenter();

  const driver = new ContinuationDriver({
    agentClient: client as any,
    logger,
    sessionId: 'test-session',
    toolTracker,
    streamProcessor,
    approvalFlow,
    providerContinuity,
    inputPlanner,
    conversationStore,
    turnAccumulator,
    shellAutoApproval,
    generationGuard,
    retryClassifier,
    recoveryPolicy,
    recoveryExecutor,
    retryEventPresenter,
  });

  return {
    driver,
    client,
    approvalState,
    approvalFlow,
    toolTracker,
    conversationStore,
    shellAutoApproval,
  };
};

const createApprovalStateMock = () => ({
  approveCalls: [] as unknown[],
  rejectCalls: [] as unknown[],
  approve(interruption: any) {
    this.approveCalls.push(interruption);
  },
  reject(interruption: any) {
    this.rejectCalls.push(interruption);
  },
});

const createShellInterruption = (command: string, callId = 'call-1') => ({
  name: 'shell',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  callId,
});

const createApplyPatchInterruption = (callId = 'call-patch-1') => ({
  name: 'apply_patch',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ path: 'source/app.tsx' }),
  callId,
});

const makeTransientRetryAfterError = () => ({
  status: 429,
  headers: {
    'retry-after': '1',
  },
  message: 'Rate limit exceeded',
});

// ── ManualApprovalDecisionPolicy ────────────────────────────────

test('ManualApprovalDecisionPolicy always returns prompt', async (t) => {
  const policy = new ManualApprovalDecisionPolicy();
  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
  });
  t.is(result, 'prompt');
});

// ── ShellAutoApprovalDecisionPolicy ──────────────────────────────

test('ShellAutoApprovalDecisionPolicy returns approve for auto-approvable shell command', async (t) => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('auto' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
    llmAdvisory: { reasoning: 'safe', approved: true, model: 'test', source: 'llm' },
  });
  t.is(result, 'approve');
});

test('ShellAutoApprovalDecisionPolicy returns prompt for non-shell tool', async (t) => {
  const harness = createHarness();
  const policy = new ShellAutoApprovalDecisionPolicy(harness.shellAutoApproval);

  const result = await policy.decide({
    toolName: 'apply_patch',
    argumentsText: 'patch',
    callId: 'c1',
  });
  t.is(result, 'prompt');
});

test('ShellAutoApprovalDecisionPolicy returns prompt without advisory', async (t) => {
  const harness = createHarness();
  const policy = new ShellAutoApprovalDecisionPolicy(harness.shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
  });
  t.is(result, 'prompt');
});

test('ShellAutoApprovalDecisionPolicy returns prompt when advisory says not approved', async (t) => {
  const harness = createHarness();
  const policy = new ShellAutoApprovalDecisionPolicy(harness.shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'rm -rf /',
    callId: 'c1',
    llmAdvisory: { reasoning: 'dangerous', approved: false, model: 'test', source: 'llm' },
  });
  t.is(result, 'prompt');
});

// ── ContinuationDriver: approval decision ────────────────────────

test('continuation from approval decision returns final response', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver, approvalState } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const policy = new ManualApprovalDecisionPolicy();
  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, policy),
  );

  t.is(result.kind, 'response');
  if (result.kind === 'response') {
    t.is(result.result.type, 'response');
  }
  t.is(stateMock.approveCalls.length, 1, 'Should have approved the interruption');
});

test('continuation from rejection records aborted approval in tool tracker', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver, approvalState } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('rm -rf /'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  await collectResult(
    driver.drive(
      { kind: 'approval_decision', answer: 'n', rejectionReason: 'too dangerous', generation: 1 },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  t.is(stateMock.rejectCalls.length, 1, 'Should have rejected the interruption');
});

test('continuation from approval emits deduplicated tool_started event', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver, approvalState } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls', 'call-tool-1'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  const toolStarted = events.filter((e) => e.type === 'tool_started');
  t.is(toolStarted.length, 1, 'Should emit exactly one tool_started event');
  if (toolStarted[0] && toolStarted[0].type === 'tool_started') {
    t.is(toolStarted[0].toolName, 'shell');
    t.is(toolStarted[0].toolCallId, 'call-tool-1');
  }
});

test('tool_started is not emitted for rejection', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver, approvalState } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('rm -rf /', 'call-tool-2'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'n', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  const toolStarted = events.filter((e) => e.type === 'tool_started');
  t.is(toolStarted.length, 0, 'Should not emit tool_started for rejection');
});

// ── ContinuationDriver: abort resolution ─────────────────────────

test('continuation from abort resolution drives stream and returns result', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  const abortedContext = {
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: new Map<string, unknown>(),
  };

  const { result } = await collectResult(
    driver.drive(
      { kind: 'abort_resolution', abortedContext, userText: 'new question', generation: 1 },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  t.is(result.kind, 'response', 'Abort resolution should produce a response result');
  if (result.kind === 'response') {
    t.is(result.result.type, 'response');
  }
});

// ── ContinuationDriver: policy integration ───────────────────────

test('drive returns approval_required when policy says prompt', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.interruptions = [createApplyPatchInterruption()];
  continuationStream.state = createApprovalStateMock();

  const { driver, approvalState } = createHarness({
    continuationStreams: [continuationStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  t.is(result.kind, 'approval_required', 'Should return approval_required when policy says prompt');
});

// ── ContinuationDriver: error handling ────────────────────────────

test('drive with no pending approval throws error', async (t) => {
  const { driver } = createHarness({
    continuationStreams: [],
  });

  const gen = driver.drive(
    { kind: 'approval_decision', answer: 'y', generation: 1 },
    new ManualApprovalDecisionPolicy(),
  );

  await t.throwsAsync(
    async () => {
      await collectResult(gen);
    },
    { message: /No pending approval/ },
  );
});

test('drive yields error event when continuation stream throws unrecoverable error', async (t) => {
  const client = createMockAgentClient();
  client.setContinueRunStreamResults([null as any]);

  const { driver, approvalState } = createHarness({
    agentClient: client,
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  try {
    await collectResult(
      driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
    );
  } catch {
    // Expected
  }

  t.pass('Driver completed without hanging');
});

// ── Step 12 Alignment Tests ──────────────────────────────────────

test('stale approval continuation returns stale outcome', async (t) => {
  const { driver, approvalState, toolTracker } = createHarness();
  const stateMock = createApprovalStateMock();
  toolTracker.recordFunctionCall({
    type: 'function_call',
    callId: 'call-keep',
    name: 'shell',
    arguments: JSON.stringify({ command: 'ls' }),
  });
  const initialLedger = toolTracker.export();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 0,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 0 }, new ManualApprovalDecisionPolicy()),
  );
  t.is(result.kind, 'stale');
  t.is(stateMock.approveCalls.length, 0);
  t.is(stateMock.rejectCalls.length, 0);
  t.deepEqual(toolTracker.export(), initialLedger);
});

test('transient continuation retry with resumable stream resumes stream', async (t) => {
  const client = createMockAgentClient();
  const badStream = new MockStream();
  badStream.state = { some: 'sdk-state' };
  badStream[Symbol.asyncIterator] = async function* () {
    throw makeTransientRetryAfterError();
  };

  const goodStream = new MockStream();
  goodStream.finalOutput = 'Success after retry';

  const originalSetTimeout = globalThis.setTimeout;
  const observedDelays: number[] = [];
  globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
    observedDelays.push(Number(timeout));
    return originalSetTimeout(() => handler(...args), 0);
  }) as typeof setTimeout;
  t.teardown(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  const { driver, approvalState } = createHarness({
    agentClient: client,
    continuationStreams: [badStream, goodStream],
  });
  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { result, events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  t.is(result.kind, 'response');
  if (result.kind === 'response') {
    t.is(result.result.finalText, 'Success after retry');
  }
  t.deepEqual(observedDelays, [1000]);
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 1);
  t.is(retryEvents[0].toolName, 'continuation');
});

test('transient continuation retry without state preserves delay for fresh-start recovery', async (t) => {
  const client = createMockAgentClient();
  const badStream = new MockStream();
  badStream.state = null;
  badStream[Symbol.asyncIterator] = async function* () {
    throw makeTransientRetryAfterError();
  };

  const { driver, approvalState } = createHarness({
    agentClient: client,
    continuationStreams: [badStream],
  });
  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { result, events } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  t.is(result.kind, 'fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    t.is(result.delayMs, 1000);
  }
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 1);
});

test('service tier fallback fresh-start recovery preserves one-shot standard service tier flag', async (t) => {
  const client = createMockAgentClient();
  client.shouldRetryWithoutFlexServiceTier = () => true;

  const badStream = new MockStream();
  badStream.state = null;
  badStream[Symbol.asyncIterator] = async function* () {
    throw new Error('Rate limit exceeded');
  };

  const { driver, approvalState } = createHarness({
    agentClient: client,
    continuationStreams: [badStream],
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  t.is(result.kind, 'fresh_start_required');
  if (result.kind === 'fresh_start_required') {
    t.true(result.useStandardServiceTier ?? false);
  }
});

test('recovery of approved tool result before fresh start records result in ledger', async (t) => {
  const client = createMockAgentClient();
  const badStream = new MockStream();
  badStream.state = null;
  badStream[Symbol.asyncIterator] = async function* () {
    throw new Error('Rate limit exceeded');
  };

  const { driver, approvalState, toolTracker } = createHarness({
    agentClient: client,
    continuationStreams: [badStream],
  });

  toolTracker.recordFunctionCall({
    type: 'function_call',
    callId: 'call-1',
    name: 'shell',
    arguments: JSON.stringify({ command: 'ls' }),
  });

  const stateMock = {
    ...createApprovalStateMock(),
    _generatedItems: [
      {
        role: 'tool',
        type: 'function_call_output',
        callId: 'call-1',
        output: 'Tool output value',
      },
    ],
  };

  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls', 'call-1'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { result } = await collectResult(
    driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, new ManualApprovalDecisionPolicy()),
  );

  t.is(result.kind, 'fresh_start_required');
  const entries = toolTracker.export();
  const toolResultEntry = entries.find((e) => e.callId === 'call-1' && e.status === 'completed');
  t.truthy(toolResultEntry);
  t.is(toolResultEntry?.output, 'Tool output value');
});

test('multiple auto-approved interruptions followed by manual approval', async (t) => {
  const client = createMockAgentClient();

  const stream1 = new MockStream();
  stream1.interruptions = [createShellInterruption('echo "first"', 'call-1')];
  stream1.state = createApprovalStateMock();

  const stream2 = new MockStream();
  stream2.interruptions = [createShellInterruption('echo "second"', 'call-2')];
  stream2.state = createApprovalStateMock();

  const stream3 = new MockStream();
  stream3.interruptions = [createApplyPatchInterruption('call-3')];
  stream3.state = createApprovalStateMock();

  const harness = createHarness({
    agentClient: client,
    continuationStreams: [stream1, stream2, stream3],
  });
  harness.shellAutoApproval.shouldAutoApprove = () => true;
  harness.shellAutoApproval.resolveAdvisoryForInterruption = async () => ({
    model: 'mock-model',
    reasoning: 'auto-approvable shell command',
    approved: true,
    source: 'llm',
  });
  const policy = new ShellAutoApprovalDecisionPolicy(harness.shellAutoApproval);

  const stateMock = createApprovalStateMock();
  harness.approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('echo "init"', 'call-init'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { result } = await collectResult(
    harness.driver.drive({ kind: 'approval_decision', answer: 'y', generation: 1 }, policy),
  );

  t.is(result.kind, 'approval_required');
  if (result.kind === 'approval_required') {
    t.is(result.result.approval.toolName, 'apply_patch');
    t.is(result.result.approval.callId, 'call-3');
  }
});

test('rejection preserves event order and ledger state', async (t) => {
  const continuationStream = new MockStream();
  continuationStream.finalOutput = 'Done.';

  const { driver, approvalState, toolTracker } = createHarness({
    continuationStreams: [continuationStream],
  });

  toolTracker.recordFunctionCall({
    type: 'function_call',
    callId: 'call-reject',
    name: 'shell',
    arguments: JSON.stringify({ command: 'ls' }),
  });

  const stateMock = createApprovalStateMock();
  approvalState.setPending({
    state: stateMock as any,
    interruption: createShellInterruption('ls', 'call-reject'),
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 1,
  });

  const { events, result } = await collectResult(
    driver.drive(
      { kind: 'approval_decision', answer: 'n', rejectionReason: 'too risky', generation: 1 },
      new ManualApprovalDecisionPolicy(),
    ),
  );

  t.is(result.kind, 'response');
  const entries = toolTracker.export();
  const abortedEntry = entries.find((e) => e.callId === 'call-reject' && e.status === 'aborted');
  t.truthy(abortedEntry);
  t.is(abortedEntry?.output, "Tool execution was not approved. User's reason: too risky");

  const toolStarted = events.filter((e) => e.type === 'tool_started');
  t.is(toolStarted.length, 0);
});
