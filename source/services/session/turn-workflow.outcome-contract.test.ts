import { it, expect } from 'vitest';
import { createSessionRuntimeInternals as createProductionSessionRuntimeInternals } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { createPostExecutePausePolicy } from './post-execute-pause-policy.js';
import {
  DelegatingShellAutoApprovalResolver,
  type ShellAutoApprovalResolver,
} from '../approval/shell-auto-approval-resolver.js';

const createSessionRuntimeInternals = (
  options: Omit<Parameters<typeof createProductionSessionRuntimeInternals>[0], 'toolOwnership'>,
) =>
  createProductionSessionRuntimeInternals({
    ...options,
    toolOwnership: new ToolOwnershipRegistry(),
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
  });

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

function setupWorkflow(mockClient: any) {
  const composition = createSessionRuntimeInternals({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });

  return { workflow: composition.turnWorkflow, composition };
}

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

const collect = async (iterable: AsyncGenerator<any, any, void>) => {
  const events: any[] = [];
  let next = await iterable.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterable.next();
  }
  return { events, outcome: next.value };
};

/** The continuation fixture used at `turn-workflow.test.ts:338-427`. */
const stubApprovalContinuationFixture = (composition: any, token: number) => {
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
};

it('forwards stopAfterApprovalResolution only when the approval decision requests it', async () => {
  // Case 1: an approval decision that requests the stop.
  const captured: any[] = [];
  const continuationClient = {
    getProvider: () => 'openai',
    async continueRunStream(_state: unknown, options: any) {
      captured.push(options);
      const stream = new MockStream([{ type: 'text_delta', text: 'continuation response' }]);
      stream.finalOutput = 'continuation response';
      return stream;
    },
  };
  const first = setupWorkflow(continuationClient);
  const firstToken = first.composition.generationGuard.capture();
  stubApprovalContinuationFixture(first.composition, firstToken);
  await collect(
    first.workflow.executeContinuation({
      kind: 'approval_decision',
      answer: 'y',
      generation: firstToken,
      stopAfterApprovalResolution: true,
    }),
  );
  expect(captured[0]!.stopAfterApprovalResolution).toBe(true);

  // Case 2: an approval decision without the field must not fabricate it.
  const second = setupWorkflow(continuationClient);
  const secondToken = second.composition.generationGuard.capture();
  stubApprovalContinuationFixture(second.composition, secondToken);
  await collect(
    second.workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: secondToken }),
  );
  // Truthiness is the downstream contract (`application-run-loop.ts:829`); do
  // not assert absence versus `false`.
  expect(captured[1]!.stopAfterApprovalResolution).toBeFalsy();
});

it('forwards a readable provider-continuity lineage of zero on an initial request', async () => {
  const stream = new MockStream([{ type: 'text_delta', text: 'hello' }]);
  stream.finalOutput = 'hello';
  let capturedOptions: any;
  const mockClient: any = {
    getProvider: () => 'openai',
    async startStream(_input: unknown, options: any) {
      capturedOptions = options;
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  expect(composition.providerContinuity.lineage).toBe(0);

  await collect(workflow.executeInitial('hello'));

  // Zero is a valid lineage, not an omitted option: AgentClient treats
  // `undefined` specially (root request preparation would be disabled).
  expect(capturedOptions.providerContinuityLineage).toBe(0);
  expect(Object.prototype.hasOwnProperty.call(capturedOptions, 'providerContinuityLineage')).toBe(true);
});

it('forwards the hook turn id to initial and continuation client requests', async () => {
  const initialStream = new MockStream([{ type: 'text_delta', text: 'initial' }]);
  initialStream.finalOutput = 'initial';
  let startOptions: any;
  let continueOptions: any;
  const mockClient: any = {
    getProvider: () => 'openai',
    async startStream(_input: unknown, options: any) {
      startOptions = options;
      return initialStream;
    },
    async continueRunStream(_state: unknown, options: any) {
      continueOptions = options;
      const stream = new MockStream([{ type: 'text_delta', text: 'continuation' }]);
      stream.finalOutput = 'continuation';
      return stream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);

  workflow.setHookTurnId('turn-1');
  await collect(workflow.executeInitial('hello'));
  expect(startOptions.hookTurnId).toBe('turn-1');

  workflow.setHookTurnId(undefined);
  const token = composition.generationGuard.capture();
  stubApprovalContinuationFixture(composition, token);
  await collect(workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: token }));
  expect(continueOptions.hookTurnId).toBeUndefined();
});

// Contract 01 §8 proof (was B1 retained red): a post-execute pause followed by
// an auto-approvable shell interruption must settle as a modeled TurnOutcome
// instead of throwing. The ordinary form failed with exactly
//   Error: Post-execute live run finished without a terminal outcome.
// (turn-workflow.ts, observed 2026-08-15 and re-observed before this repair)
// because `buildConversationResult` returns the reachable `auto_approve`
// result for the real shell interruption while `#continuePostExecuteRun`
// handled only `response` and `approval_required`. The repair settles that
// reachable `auto_approve` result with initial-path parity
// (`turn-workflow.test.ts:685`): the same auto-approval continuation the
// initial path drives is driven here, so exactly one continuation stream is
// opened and the turn settles as the continuation's modeled `TurnOutcome`
// rather than re-prompting a decision the policy already made.
it('settles a post-execute resume whose completed stream auto-approves a shell interruption', async () => {
  let continuationOptions: any;
  const continuationStream = new MockStream([{ type: 'text_delta', text: 'auto-approved' }]);
  continuationStream.finalOutput = 'auto-approved';
  const mockClient: any = {
    getProvider: () => 'openai',
    async continueRunStream(_state: unknown, options: any) {
      // Initial-path parity opens the auto-approval continuation; an
      // approval-required fallback would never reach the client.
      continuationOptions = options;
      return continuationStream;
    },
  };
  const { workflow, composition } = setupWorkflow(mockClient);
  // Drive auto-approval through the public delegating resolver so the real
  // shell interruption in buildConversationResult reaches the `auto_approve`
  // result.
  (composition.shellAutoApproval as DelegatingShellAutoApprovalResolver).setDelegate({
    getAutoApproveMode: () => 'always',
    isUnsandboxedApprovalEligible: () => true,
    shouldAutoApprove: () => true,
    resolveAdvisoryForInterruption: async () => undefined,
    recordManualDecision: () => {},
    clearCache: () => {},
  } as unknown as ShellAutoApprovalResolver);

  const policy = createPostExecutePausePolicy({
    pending: composition.postExecutePending,
    runId: 'test-session:live:1',
    describe: () => ({ toolName: 'shell', argumentsText: '{"command":"pwd"}' }),
  });
  let consumed = 0;
  const stream = new MockStream([{ type: 'text_delta', text: 'resumed' }]);
  stream.finalOutput = 'resumed';
  stream.interruptions = [
    { type: 'tool_approval_item', callId: 'call-a', name: 'shell', arguments: '{"command":"pwd"}' },
  ];
  stream.state = {};
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
  composition.postExecutePending.decide({
    revision: snapshot.revision,
    ids: [snapshot.entries[0].id],
    decision: 'approve',
  });

  const resumed = await collect(
    workflow.executeContinuation({ kind: 'approval_decision', answer: 'y', generation: token }),
  );
  // Initial-path parity: the auto-approval continuation settles the turn as a
  // response (its finalText), and the resumed post-execute live run is not
  // consumed a second time.
  expect(resumed.outcome).toMatchObject({ kind: 'response', terminal: { finalText: 'auto-approved' } });
  expect(continuationOptions).toBeDefined();
  expect(consumed).toBe(1);
});
