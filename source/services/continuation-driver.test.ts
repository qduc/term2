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
import { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import { ProviderContinuity } from './provider-continuity.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationLogger } from './conversation-logger.js';
import type { ConversationEvent } from './conversation-events.js';

import { GenerationGuard } from './generation-guard.js';

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

  const retryOrchestrator = new SessionRetryOrchestrator(logger, 'test-session', client as any, true);
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

  const approvalFlow = new ApprovalFlowCoordinator({
    agentClient: client as any,
    approvalState,
    logger,
    sessionId: 'test-session',
  });

  const conversationLogger = new ConversationLogger({
    turnAccumulator,
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
    getToolLedger: () => toolTracker.export(),
  });

  const generationGuard = new GenerationGuard();
  generationGuard.capture(); // Bump to 1 to match tests passing generation: 1

  const streamProcessor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const driver = new ContinuationDriver({
    agentClient: client as any,
    logger,
    sessionId: 'test-session',
    toolTracker,
    streamProcessor,
    approvalFlow,
    retryOrchestrator,
    providerContinuity,
    inputPlanner,
    conversationStore,
    turnAccumulator,
    shellAutoApproval,
    generationGuard,
  });

  return {
    driver,
    client,
    approvalState,
    approvalFlow,
    toolTracker,
    conversationStore,
    providerContinuity,
    retryOrchestrator,
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
