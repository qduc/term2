import { it, expect } from 'vitest';
import { createSessionRuntimeInternals as createProductionSessionRuntimeInternals } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { createPostExecutePausePolicy } from './post-execute-pause-policy.js';
import { PostExecutePauseCapability } from './post-execute-pause-capability.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

const createSessionRuntimeInternals = (
  options: Omit<Parameters<typeof createProductionSessionRuntimeInternals>[0], 'toolOwnership'>,
) => createProductionSessionRuntimeInternals({ ...options, toolOwnership: new ToolOwnershipRegistry() });

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = () => {
  let capturedContext: any = null;
  return {
    runWithContext: (context: any, fn: any) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

function setupWorkflow(mockClient: any, retryOptions?: any, openAIRootFreshTurnSelectorParityObserver?: any) {
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
    retryOptions,
    openAIRootFreshTurnSelectorParityObserver,
  });

  return { workflow: composition.turnWorkflow, composition };
}

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

it('executes initial turn successfully', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello response' }]);
  stream.finalOutput = 'hello response';
  let receivedProviderHistorySnapshot: unknown;
  let receivedLineage: unknown;

  const mockClient: any = {
    getProvider() {
      return 'openai';
    },
    async startStream(
      _input: unknown,
      options: { providerHistorySnapshot?: unknown; providerContinuityLineage?: unknown },
    ) {
      receivedProviderHistorySnapshot = options.providerHistorySnapshot;
      receivedLineage = options.providerContinuityLineage;
      return stream;
    },
  };

  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const iterator = workflow.executeInitial(attempt);
    let res = await iterator.next();
    while (!res.done) {
      events.push(res.value);
      res = await iterator.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    expect(outcome.terminal.finalText).toBe('hello response');
  } else {
    expect(true).toBe(false);
  }
  expect(attempt.closed).toBe(true);
  expect(receivedProviderHistorySnapshot).toBe(attempt.providerHistorySnapshot);
  expect(receivedLineage).toBe(composition.providerContinuity.lineage);
  expect(Object.isFrozen(receivedProviderHistorySnapshot)).toBe(true);
});

it('requests the standard tier before starting a flagged initial attempt', async () => {
  const calls: string[] = [];
  const stream = new MockStream([{ type: 'text_delta', text: 'standard tier response' }]);
  stream.finalOutput = 'standard tier response';
  const mockClient: any = {
    getProvider() {
      return 'openai';
    },
    useStandardServiceTierForNextRequest() {
      calls.push('standard-tier');
    },
    async startStream() {
      calls.push('start-stream');
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const { outcome } = await collect(workflow.executeInitial(attempt, { useStandardServiceTier: true }));

  expect(outcome).toMatchObject({
    kind: 'response',
    terminal: { type: 'response', finalText: 'standard tier response' },
  });
  expect(calls).toEqual(['standard-tier', 'start-stream']);
});

it('starts a flagged initial attempt when the tier override capability is absent', async () => {
  const calls: string[] = [];
  const stream = new MockStream([{ type: 'text_delta', text: 'no override response' }]);
  stream.finalOutput = 'no override response';
  const mockClient: any = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      calls.push('start-stream');
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const { outcome } = await collect(workflow.executeInitial(attempt, { useStandardServiceTier: true }));

  expect(outcome).toMatchObject({
    kind: 'response',
    terminal: { type: 'response', finalText: 'no override response' },
  });
  expect(calls).toEqual(['start-stream']);
});

it('does not request the standard tier for an unflagged initial attempt', async () => {
  const calls: string[] = [];
  const stream = new MockStream([{ type: 'text_delta', text: 'normal response' }]);
  stream.finalOutput = 'normal response';
  const mockClient: any = {
    getProvider() {
      return 'openai';
    },
    useStandardServiceTierForNextRequest() {
      calls.push('standard-tier');
    },
    async startStream() {
      calls.push('start-stream');
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const { outcome } = await collect(workflow.executeInitial(attempt));

  expect(outcome).toMatchObject({
    kind: 'response',
    terminal: { type: 'response', finalText: 'normal response' },
  });
  expect(calls).toEqual(['start-stream']);
});

it('observes eligible owned-root OpenAI parity while preserving the legacy outgoing response ID', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  const observations: any[] = [];
  const diagnostics: any[] = [];
  let outgoingOptions: any;
  const mockClient = {
    getProvider: () => 'openai',
    supportsConversationChaining: () => true,
    async startStream(_input: unknown, options: unknown) {
      outgoingOptions = options;
      return stream;
    },
  };
  let recordEvidence: ((value: unknown) => void) | undefined;
  const { workflow, composition } = setupWorkflow(mockClient, undefined, {
    setEvidenceRecorder: (recorder: (value: unknown) => void) => {
      recordEvidence = recorder;
    },
    observe: (value: unknown) => {
      observations.push(value);
      recordEvidence?.({ type: 'openai_root_selector_parity', version: 2, eligible: true, matches: true });
      return {
        eligible: true,
        legacyPreviousResponseId: 'resp-legacy',
        acceptedCheckpointResponseId: 'resp-legacy',
        matches: true,
      };
    },
  });
  composition.conversationLogger.setLogSink((event) => diagnostics.push(event));
  composition.conversationStore.replaceHistory([{ role: 'user', type: 'message', content: 'before' }] as any);
  const committed = composition.conversationStore.getProviderHistorySnapshot();
  const binding = {
    identity: { provider: 'openai', endpoint: 'responses', model: 'gpt-5' },
    prefix: { identity: committed.identity, revision: committed.revision },
  };
  composition.providerContinuity.observeCandidate({ ...binding, responseId: 'resp-legacy' });
  composition.providerContinuity.publishTerminalResponse('resp-legacy', true, committed);

  await collect(workflow.executeInitial('next'));

  expect(outgoingOptions.previousResponseId).toBe('resp-legacy');
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ legacyPreviousResponseId: 'resp-legacy' });
  expect(diagnostics).toContainEqual({
    type: 'openai_root_selector_parity',
    version: 2,
    eligible: true,
    matches: true,
    turnId: expect.any(String),
  });
  expect(JSON.stringify(diagnostics)).not.toContain('resp-legacy');
});

it('keeps the legacy response ID when an eligible checkpoint does not match it', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  let outgoingOptions: any;
  const { workflow, composition } = setupWorkflow(
    {
      getProvider: () => 'openai',
      supportsConversationChaining: () => true,
      async startStream(_input: unknown, options: unknown) {
        outgoingOptions = options;
        return stream;
      },
    },
    undefined,
    {
      observe: () => ({
        eligible: true,
        legacyPreviousResponseId: 'resp-legacy',
        acceptedCheckpointResponseId: 'resp-checkpoint',
        matches: false,
      }),
    },
  );
  composition.providerContinuity.update('resp-legacy');

  await collect(workflow.executeInitial('next'));

  expect(outgoingOptions.previousResponseId).toBe('resp-legacy');
});

it.each([
  [
    'ineligible checkpoint',
    () => ({ eligible: false, acceptedCheckpointResponseId: 'resp-checkpoint', matches: false }),
  ],
  [
    'faulty observer',
    () => {
      throw new Error('selector unavailable');
    },
  ],
])('keeps the legacy response ID for a %s', async (_name, observe) => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  let outgoingOptions: any;
  const { workflow, composition } = setupWorkflow(
    {
      getProvider: () => 'openai',
      supportsConversationChaining: () => true,
      async startStream(_input: unknown, options: unknown) {
        outgoingOptions = options;
        return stream;
      },
    },
    undefined,
    { observe },
  );
  composition.providerContinuity.update('resp-legacy');

  await collect(workflow.executeInitial('next'));

  expect(outgoingOptions.previousResponseId).toBe('resp-legacy');
});

it('keeps the established outgoing response ID when parity observation throws', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  let outgoingOptions: any;
  const mockClient = {
    getProvider: () => 'openai',
    supportsConversationChaining: () => true,
    async startStream(_input: unknown, options: unknown) {
      outgoingOptions = options;
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient, undefined, {
    observe: () => {
      throw new Error('observation failed');
    },
  });
  composition.providerContinuity.update('resp-legacy');

  await collect(workflow.executeInitial('next'));

  expect(outgoingOptions.previousResponseId).toBe('resp-legacy');
});

it.each([
  ['Codex', { getProvider: () => 'codex', supportsConversationChaining: () => true }, {}],
  ['full-history', { getProvider: () => 'openai', supportsConversationChaining: () => false }, {}],
  ['replay', { getProvider: () => 'openai', supportsConversationChaining: () => true }, { replayFromHistory: true }],
  [
    'retry',
    { getProvider: () => 'openai', supportsConversationChaining: () => true },
    { retries: { transientRetryCount: 1 } },
  ],
])('does not observe %s initial paths', async (_name, clientShape, runOptions) => {
  const observations: any[] = [];
  const diagnostics: any[] = [];
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  const mockClient = { ...clientShape, startStream: async () => stream };
  let recordEvidence: ((value: unknown) => void) | undefined;
  const { workflow, composition } = setupWorkflow(mockClient, undefined, {
    setEvidenceRecorder: (recorder: (value: unknown) => void) => {
      recordEvidence = recorder;
    },
    observe: (value: unknown) => {
      observations.push(value);
      recordEvidence?.({ type: 'openai_root_selector_parity', version: 2, eligible: true, matches: true });
    },
  });
  composition.conversationLogger.setLogSink((event) => diagnostics.push(event));
  composition.providerContinuity.update('resp-legacy');

  await collect(workflow.executeInitial('next', runOptions));

  expect(observations).toEqual([]);
  expect(diagnostics).toEqual([]);
});

it('passes a fresh authoritative store snapshot when resuming an initial stream', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'resumed response' }]);
  stream.finalOutput = 'resumed response';
  let receivedProviderHistorySnapshot: any;
  let receivedLineage: unknown;
  const mockClient: any = {
    getProvider: () => 'openai',
    async continueRunStream(
      _state: unknown,
      options: { providerHistorySnapshot?: unknown; providerContinuityLineage?: unknown },
    ) {
      receivedProviderHistorySnapshot = options.providerHistorySnapshot;
      receivedLineage = options.providerContinuityLineage;
      return stream;
    },
  };
  const observations: any[] = [];
  const { workflow, composition } = setupWorkflow(mockClient, undefined, {
    observe: (value: unknown) => observations.push(value),
  });
  composition.conversationStore.replaceHistory([{ role: 'user', type: 'message', content: 'authoritative' }] as any);
  const getAuthoritativeSnapshot = composition.conversationStore.getProviderHistorySnapshot.bind(
    composition.conversationStore,
  );
  const plannedSnapshot = getAuthoritativeSnapshot();
  const resumedSnapshot = getAuthoritativeSnapshot();
  let snapshotReads = 0;
  composition.conversationStore.getProviderHistorySnapshot = () =>
    [plannedSnapshot, resumedSnapshot][snapshotReads++] ?? getAuthoritativeSnapshot();
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'resume' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const result = await collect(workflow.executeInitial(attempt, { resumeState: {} as any }));

  expect(result.outcome).toMatchObject({ kind: 'response', terminal: { finalText: 'resumed response' } });
  expect(attempt.providerHistorySnapshot).toBe(plannedSnapshot);
  expect(receivedProviderHistorySnapshot).toBe(resumedSnapshot);
  expect(receivedLineage).toBe(composition.providerContinuity.lineage);
  expect(snapshotReads).toBeGreaterThanOrEqual(2);
  expect(Object.isFrozen(receivedProviderHistorySnapshot)).toBe(true);
  expect(observations).toEqual([]);
});

it('executes continuation turn successfully', async () => {
  let receivedLineage: unknown;
  let receivedPreviousResponseId: unknown;
  let selectorCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async continueRunStream(
      _state: unknown,
      options: { providerContinuityLineage?: unknown; previousResponseId?: unknown },
    ) {
      receivedLineage = options.providerContinuityLineage;
      receivedPreviousResponseId = options.previousResponseId;
      const stream = new MockStream([{ type: 'text_delta', text: 'continuation response' }]);
      stream.finalOutput = 'continuation response';
      const prior = {
        type: 'function_call_output',
        call_id: 'prior',
        output: '{"text":"old","metadata":{"messageId":"m-prior"}}',
      };
      const current = {
        type: 'function_call_output',
        call_id: 'current',
        output: '{"text":"new","metadata":{"messageId":"m-current"}}',
      };
      stream.history = [prior, current];
      stream.output = [current];
      return stream;
    },
  };

  const { workflow, composition } = setupWorkflow(mockClient, undefined, {
    observe: () => {
      selectorCalls++;
      throw new Error('selector must not run for approval continuation');
    },
  });
  composition.providerContinuity.update('resp-legacy');

  const token = composition.generationGuard.capture();
  composition.approvalFlow.prepareContinuation = () =>
    ({
      pendingApprovalContext: {
        state: {},
        interruption: {
          type: 'tool_approval_item',
          callId: 'call-1',
          name: 'shell',
          arguments: '{}',
        },
        toolCallArgumentsById: new Map([['call-1', '{}']]),
        emittedCommandIds: new Set<string>(),
        token,
        inputMode: 'delta',
        cumulativeUsage: {},
        cumulativeCommandMessages: [],
        cumulativeTurnItems: [],
      },
      toolStartedEvent: undefined,
    } as any);

  const events: any[] = [];
  const runPromise = (async () => {
    const iterator = workflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: token,
    });
    let res = await iterator.next();
    while (!res.done) {
      events.push(res.value);
      res = await iterator.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    expect(outcome.terminal.finalText).toBe('continuation response');
    expect(outcome.terminal.commandMessages?.map((message) => message.callId)).toEqual(['current']);
    expect(outcome.terminal.turnItems?.map((item) => item.type)).toEqual(['tool_result']);
    expect(outcome.terminal.turnItems?.[0]).toMatchObject({ callId: 'current' });
  } else {
    expect(true).toBe(false);
  }
  expect(receivedLineage).toBe(composition.providerContinuity.lineage);
  expect(receivedPreviousResponseId).toBe('resp-legacy');
  expect(selectorCalls).toBe(0);
});

// Regression: the continuation cycle rebuilds the response terminal, and the
// rebuild dropped `costRecords`. Every turn that used a tool or paused for
// approval therefore reached the UI and the conversation log unpriced, even
// though the run loop had priced it.
it('carries cost records through the continuation rebuild of the response terminal', async () => {
  const costRecords = [{ usdMicros: 4200, source: 'catalog' as const }];
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async continueRunStream() {
      const stream = new MockStream([{ type: 'text_delta', text: 'continuation response' }]);
      stream.finalOutput = 'continuation response';
      (stream as any).runCostRecords = costRecords;
      return stream;
    },
  };

  const { workflow, composition } = setupWorkflow(mockClient);
  const token = composition.generationGuard.capture();
  composition.approvalFlow.prepareContinuation = () =>
    ({
      pendingApprovalContext: {
        state: {},
        interruption: { type: 'tool_approval_item', callId: 'call-1', name: 'shell', arguments: '{}' },
        toolCallArgumentsById: new Map([['call-1', '{}']]),
        emittedCommandIds: new Set<string>(),
        token,
        inputMode: 'delta',
        cumulativeUsage: {},
        cumulativeCommandMessages: [],
        cumulativeTurnItems: [],
      },
      toolStartedEvent: undefined,
    } as any);

  const iterator = workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: token });
  let res = await iterator.next();
  while (!res.done) res = await iterator.next();
  const outcome = res.value;

  expect(outcome.kind).toBe('response');
  if (outcome.kind !== 'response' || outcome.terminal.type !== 'response') throw new Error('expected a response');
  expect(outcome.terminal.costRecords).toEqual(costRecords);
});

it('resumes one post-execute-gated stream without consuming it twice', async () => {
  const mockClient: any = {
    getProvider: () => 'openai',
    continueRunStream: async () => {
      throw new Error('post-execute continuation must not create a second stream');
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  const policy = createPostExecutePausePolicy({
    pending: composition.postExecutePending,
    runId: 'test-session:live:1',
    describe: () => ({ toolName: 'shell', argumentsText: '{"command":"pwd"}' }),
  });
  let consumed = 0;
  const stream = new MockStream([{ type: 'text_delta', text: 'resumed' }]);
  stream.finalOutput = 'resumed';
  (stream as any)[Symbol.asyncIterator] = async function* () {
    consumed++;
    await policy({
      params: {},
      result: 'original',
      details: { toolCall: { callId: 'call-a' } },
      executeAgain: async () => 'retried',
    });
    yield { type: 'text_delta', text: 'resumed' };
  };
  mockClient.startStream = async () => stream;

  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'run' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });
  const first = await collect(workflow.executeInitial(attempt));
  expect(first.outcome).toMatchObject({ kind: 'approval_required', terminal: { type: 'approval_required' } });
  expect(consumed).toBe(1);

  const snapshot = composition.postExecutePending.snapshot();
  expect(
    composition.postExecutePending.decide({
      revision: snapshot.revision,
      ids: [snapshot.entries[0].id],
      decision: 'approve',
    }),
  ).toMatchObject({ kind: 'settled' });
  const resumed = await collect(
    workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: token }),
  );
  expect(resumed.outcome).toMatchObject({ kind: 'response', terminal: { finalText: 'resumed' } });
  expect(consumed).toBe(1);
});

it('establishes the active live-run id before a synchronously starting client can reach an opted-in tool', async () => {
  const pending = new PostExecutePendingRegistry({ sessionId: 'test-session', epoch: 'epoch-a' });
  const capability = new PostExecutePauseCapability(pending);
  const definition: any = {
    postExecutePause: { describe: () => ({ toolName: 'shell', argumentsText: '{}' }) },
  };
  let gate!: Promise<unknown>;
  const stream = new MockStream([{ type: 'text_delta', text: 'done' }]);
  stream.finalOutput = 'done';
  const mockClient: any = {
    getProvider: () => 'openai',
    async startStream() {
      // This models a client whose stream startup begins tool work before its
      // startStream promise resolves.
      gate = Promise.resolve(
        capability.forTool(definition)!({
          params: {},
          result: 'first',
          details: { toolCall: { callId: 'call-sync' } },
          executeAgain: async () => 'second',
        }),
      );
      return stream;
    },
  };
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
    postExecutePending: pending,
    postExecutePauseCapability: capability,
  });
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'run' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const first = await collect(composition.turnWorkflow.executeInitial(attempt));
  expect(first.outcome).toMatchObject({ kind: 'approval_required' });
  expect(pending.snapshot().entries).toMatchObject([{ toolCallId: 'call-sync', runId: 'test-session:live:1' }]);
  const snapshot = pending.snapshot();
  pending.decide({ revision: snapshot.revision, ids: [snapshot.entries[0]!.id], decision: 'approve' });
  await expect(gate).resolves.toBe('second');
});

it('returns each later post-execute pause from the same live stream', async () => {
  const mockClient: any = { getProvider: () => 'openai', startStream: async () => stream };
  const { workflow, composition } = setupWorkflow(mockClient);
  const policy = createPostExecutePausePolicy({
    pending: composition.postExecutePending,
    runId: 'test-session:live:1',
    describe: () => ({ toolName: 'shell', argumentsText: '{}' }),
  });
  let consumed = 0;
  const stream = new MockStream([{ type: 'text_delta', text: 'done' }]);
  stream.finalOutput = 'done';
  (stream as any)[Symbol.asyncIterator] = async function* () {
    consumed++;
    for (const callId of ['call-a', 'call-b']) {
      await policy({
        params: {},
        result: 'original',
        details: { toolCall: { callId } },
        executeAgain: async () => 'retried',
      });
    }
    yield { type: 'text_delta', text: 'done' };
  };
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'run' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  await collect(workflow.executeInitial(attempt));
  let snapshot = composition.postExecutePending.snapshot();
  composition.postExecutePending.decide({
    revision: snapshot.revision,
    ids: [snapshot.entries[0].id],
    decision: 'approve',
  });
  const secondPause = await collect(
    workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: token }),
  );
  expect(secondPause.outcome).toMatchObject({ kind: 'approval_required', terminal: { type: 'approval_required' } });
  snapshot = composition.postExecutePending.snapshot();
  composition.postExecutePending.decide({
    revision: snapshot.revision,
    ids: [snapshot.entries[0].id],
    decision: 'reject',
  });
  const final = await collect(
    workflow.executeContinuation({ kind: 'approval_decision', answer: 'n', generation: token }),
  );
  expect(final.outcome).toMatchObject({ kind: 'response', terminal: { finalText: 'done' } });
  expect(consumed).toBe(1);
});

const collect = async (iterable: AsyncGenerator<any, any, void>) => {
  const events: any[] = [];
  let next = await iterable.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterable.next();
  }
  return { events, outcome: next.value };
};

it('executeInitial resolves aborted approvals through continuation', async () => {
  const { workflow } = setupWorkflow(null);
  const abortedContext = { token: 7, interruption: { id: 'interrupt-1' } };

  (workflow as any).executeInitialAttempt = async function* () {
    yield { type: 'text_delta', delta: 'initial text' };
    return {
      kind: 'abort_resolution_required',
      abortedContext,
      userText: 'next request',
      generation: 7,
    };
  };

  (workflow as any).executeContinuationAttempt = async function* (init: any) {
    expect(init).toEqual({
      kind: 'abort_resolution',
      abortedContext,
      userText: 'next request',
      generation: 7,
    });
    yield { type: 'text_delta', delta: 'continuation text' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'final response' },
    };
  };

  const result = await collect(workflow.executeInitial('next request'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'initial text' },
    { type: 'text_delta', delta: 'continuation text' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'final response' },
  });
});

it('executeInitial auto-approves shell approvals', async () => {
  const { workflow } = setupWorkflow(null);

  (workflow as any).executeInitialAttempt = async function* () {
    yield { type: 'text_delta', delta: 'initial text' };
    return {
      kind: 'auto_approval_required',
      generation: 5,
      callId: 'call-1',
      command: 'echo ok',
    };
  };

  (workflow as any).executeContinuationAttempt = async function* (init: any) {
    expect(init).toEqual({
      kind: 'approval_decision',
      answer: 'y',
      generation: 5,
    });
    yield { type: 'text_delta', delta: 'auto-approving' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'auto-approved response' },
    };
  };

  const result = await collect(workflow.executeInitial('run command'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'initial text' },
    { type: 'text_delta', delta: 'auto-approving' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'auto-approved response' },
  });
});

it('executeInitial redrives initial execution when continuation requests a fresh start', async () => {
  const { workflow } = setupWorkflow(null);
  let initialAttemptCount = 0;

  (workflow as any).executeInitialAttempt = async function* (input: any, options: any) {
    initialAttemptCount++;
    if (initialAttemptCount === 1) {
      expect(input).toBe('run command');
      yield { type: 'text_delta', delta: 'attempt 1' };
      return {
        kind: 'auto_approval_required',
        generation: 9,
      };
    } else {
      expect(input).toEqual({ text: '' });
      expect(options).toEqual({
        skipUserMessage: true,
        retries: {
          transientRetryCount: 1,
          serviceTierFallbackCount: 0,
          modelRetryCount: 0,
          transportDowngradeCount: 0,
        },
        delayMs: 25,
        useStandardServiceTier: true,
        token: 9,
        replayFromHistory: true,
      });
      yield { type: 'text_delta', delta: 'attempt 2' };
      return {
        kind: 'response',
        terminal: { type: 'response', finalText: 'recovered' },
      };
    }
  };

  (workflow as any).executeContinuationAttempt = async function* () {
    yield { type: 'text_delta', delta: 'continuation' };
    return {
      kind: 'fresh_start_required',
      retryCounts: {
        transientRetryCount: 1,
        serviceTierFallbackCount: 0,
        modelRetryCount: 0,
        transportDowngradeCount: 0,
      },
      delayMs: 25,
      useStandardServiceTier: true,
    };
  };

  const result = await collect(workflow.executeInitial('run command'));
  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'attempt 1' },
    { type: 'text_delta', delta: 'continuation' },
    { type: 'text_delta', delta: 'attempt 2' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });
});

it('executeContinuation redrives initial execution when recovery requests a fresh start', async () => {
  const { workflow } = setupWorkflow(null);

  (workflow as any).executeContinuationAttempt = async function* () {
    yield { type: 'text_delta', delta: 'continuation fail' };
    return {
      kind: 'fresh_start_required',
      retryCounts: {
        transientRetryCount: 2,
        serviceTierFallbackCount: 0,
        modelRetryCount: 0,
        transportDowngradeCount: 0,
      },
      delayMs: 50,
    };
  };

  (workflow as any).executeInitialAttempt = async function* (input: any, options: any) {
    expect(input).toEqual({ text: '' });
    expect(options).toEqual({
      skipUserMessage: true,
      retries: { transientRetryCount: 2, serviceTierFallbackCount: 0, modelRetryCount: 0, transportDowngradeCount: 0 },
      delayMs: 50,
      token: 11,
      replayFromHistory: true,
    });
    yield { type: 'text_delta', delta: 'initial recovered' };
    return {
      kind: 'response',
      terminal: { type: 'response', finalText: 'recovered' },
    };
  };

  const result = await collect(
    workflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: 11,
    }),
  );

  expect(result.events).toEqual([
    { type: 'text_delta', delta: 'continuation fail' },
    { type: 'text_delta', delta: 'initial recovered' },
  ]);
  expect(result.outcome).toEqual({
    kind: 'response',
    terminal: { type: 'response', finalText: 'recovered' },
  });
});

it('throws explicit error when continuePostExecute is called without a live run', async () => {
  const { workflow } = setupWorkflow(null);
  const generator = workflow.continuePostExecute();
  await expect(generator.next()).rejects.toThrow('No live post-execute run active to continue.');
});
