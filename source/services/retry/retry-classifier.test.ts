import { it, expect } from 'vitest';
import { ModelBehaviorError } from '../../contracts/model-errors.js';
import { OpenAICompatibleError } from '../../providers/common/provider-errors.js';
import { MissingChainedToolOutputError, OrphanedChainedToolOutputError } from '../../lib/chained-input-filter.js';
import type { ClassificationContext } from './retry-contracts.js';
import { AmbiguousModelOutcomeError, ConversationStateNoProgressError } from './retry-errors.js';
import { DefaultRetryClassifier } from './retry-classifier.js';
import { RetryRecoveryBudgetExhaustedError } from './retry-recovery-budget.js';
import { UnsentWebSocketRequestError } from '../../providers/websocket-request-dispatch.js';

const makeClassifier = (agentClient: Record<string, any> = {}, random: () => number = Math.random) =>
  new DefaultRetryClassifier(agentClient as any, random);

const baseCounts = (): ClassificationContext['retryCounts'] => ({
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
});

const baseContext = (overrides: Partial<ClassificationContext> = {}): ClassificationContext => ({
  error: new Error('boom'),
  retryCounts: baseCounts(),
  stream: null,
  maxTransientRetries: 5,
  ...overrides,
});

it('classify terminates an ambiguous provider outcome instead of replaying the turn', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({ error: new AmbiguousModelOutcomeError('request accepted but response was not acknowledged') }),
  );

  expect(result.kind).toBe('unrecoverable');
});

// A budget-exhaustion error means RetryingModel already refused to claim
// another physical attempt against the shared 90s/3-attempt envelope.
// Classifying it as anything but terminal would send the session layer back
// into a retry that immediately re-throws the same error, bouncing forever
// between the two layers instead of stopping cleanly.
it('classify terminates instead of bouncing on a budget-exhaustion error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new RetryRecoveryBudgetExhaustedError() }));

  expect(result.kind).toBe('unrecoverable');
});

it('classifies a positively unsent websocket request as non-replaying chain recovery', () => {
  const classifier = makeClassifier({}, () => 0);

  const result = classifier.classify(baseContext({ error: new UnsentWebSocketRequestError('connect timed out') }));

  expect(result).toMatchObject({ kind: 'chain_recovery', attempt: 1, cause: 'connection_interrupted' });
});

// outputPush() in application-run-loop.ts pushes run_budget evidence and
// context_compaction_* lifecycle events into stream.output/newItems
// unconditionally, even for a request that fails before producing anything.
// A bare `.length > 0` check on those arrays used to treat their mere
// presence as "committed output" and force 'unrecoverable' -- see
// agent-stream.test.ts's streamHasCommittedOutput cases for the underlying
// predicate. This proves the effect at the classifier level: an otherwise
// safely recoverable transient failure still classifies as transient when
// the only stream activity was bookkeeping.
it('classify still recovers a transient failure when the stream carries only bookkeeping evidence', () => {
  const classifier = makeClassifier();
  const error = new Error('Codex WebSocket closed before a terminal response event.');
  const stream = {
    completed: Promise.resolve(undefined),
    output: [
      { type: 'run_budget', evidence: { type: 'budget_stage', stage: 'warning' } },
      { type: 'context_compaction_started', provider: 'openai' },
    ],
    newItems: [],
  } as any;

  const result = classifier.classify(baseContext({ error, stream }));

  expect(result.kind).toBe('transient');
});

// The other half: once the stream carries real streamed text, the same
// transient failure must not replay -- the guard's actual purpose.
it('classify refuses to replay a transient failure once the stream carries real text output', () => {
  const classifier = makeClassifier();
  const error = new Error('Codex WebSocket closed before a terminal response event.');
  const stream = {
    completed: Promise.resolve(undefined),
    output: [
      { type: 'run_budget', evidence: { type: 'budget_stage', stage: 'warning' } },
      { type: 'text_delta', text: 'partial answer already shown to the user' },
    ],
    newItems: [],
  } as any;

  const result = classifier.classify(baseContext({ error, stream }));

  expect(result.kind).toBe('unrecoverable');
});

// And truthful tool settlement: a dispatched (but not yet resolved) tool
// call is exactly the case that must not be blindly replayed or redispatched.
it('classify refuses to replay a transient failure once a tool call was dispatched', () => {
  const classifier = makeClassifier();
  const error = new Error('Codex WebSocket closed before a terminal response event.');
  const stream = {
    completed: Promise.resolve(undefined),
    output: [{ type: 'tool_call_dispatched', callId: 'call-1', toolName: 'bash' }],
    newItems: [],
  } as any;

  const result = classifier.classify(baseContext({ error, stream }));

  expect(result.kind).toBe('unrecoverable');
});

const flakyClose = () =>
  new AmbiguousModelOutcomeError(
    'Codex WebSocket connection closed before a terminal response event. (code=1006 reason="" unsent=0)',
  );

const settledReadFileContinuation = {
  completedToolCount: 1,
  allToolsCompleted: true,
  completedPairsPresentInHistory: true,
};

it('classify chain-recovers a flaky close after every live-turn tool completed and is in history', () => {
  const classifier = makeClassifier({}, () => 0);
  const stream = {
    completed: Promise.resolve(undefined),
    output: [
      { type: 'tool_call_dispatched', callId: 'call-1', toolName: 'read_file' },
      { type: 'item', item: { type: 'function_call_output', callId: 'call-1', output: 'ok' } },
    ],
    newItems: [],
  } as any;

  const result = classifier.classify(
    baseContext({
      error: flakyClose(),
      stream,
      hasCommittedOutput: true,
      committedToolContinuation: settledReadFileContinuation,
    }),
  );

  expect(result).toMatchObject({ kind: 'chain_recovery', attempt: 1, cause: 'connection_interrupted' });
});

it('classify still refuses a flaky close when a dispatched tool has no completed result', () => {
  const classifier = makeClassifier();
  const stream = {
    completed: Promise.resolve(undefined),
    output: [{ type: 'tool_call_dispatched', callId: 'call-1', toolName: 'bash' }],
    newItems: [],
  } as any;

  const result = classifier.classify(
    baseContext({
      error: flakyClose(),
      stream,
      hasCommittedOutput: true,
      committedToolContinuation: {
        completedToolCount: 0,
        allToolsCompleted: false,
        completedPairsPresentInHistory: false,
      },
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify still refuses a flaky close when completed tools are missing from reconciled history', () => {
  const classifier = makeClassifier();
  const stream = {
    completed: Promise.resolve(undefined),
    output: [{ type: 'tool_call_dispatched', callId: 'call-1', toolName: 'read_file' }],
    newItems: [],
  } as any;

  const result = classifier.classify(
    baseContext({
      error: flakyClose(),
      stream,
      hasCommittedOutput: true,
      committedToolContinuation: {
        completedToolCount: 1,
        allToolsCompleted: true,
        completedPairsPresentInHistory: false,
      },
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify still refuses a flaky close after committed text when no tools completed', () => {
  const classifier = makeClassifier();
  const stream = {
    completed: Promise.resolve(undefined),
    output: [{ type: 'text_delta', text: 'partial answer already shown to the user' }],
    newItems: [],
  } as any;

  const result = classifier.classify(
    baseContext({
      error: flakyClose(),
      stream,
      hasCommittedOutput: true,
      committedToolContinuation: {
        completedToolCount: 0,
        allToolsCompleted: true,
        completedPairsPresentInHistory: true,
      },
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify does not return service_tier_fallback when already attempted', () => {
  const classifier = makeClassifier({ shouldRetryWithoutFlexServiceTier: () => true });

  const result = classifier.classify(
    baseContext({
      retryCounts: { ...baseCounts(), serviceTierFallbackCount: 1 },
    }),
  );

  expect(result.kind).not.toBe('service_tier_fallback');
});

it('classify does not call forceTransportDowngrade for non-retryable errors', () => {
  let downgradeCalled = false;
  const classifier = makeClassifier({
    forceTransportDowngrade: () => {
      downgradeCalled = true;
      return true;
    },
  });

  const result = classifier.classify(baseContext({ error: new Error('boom') }));

  expect(result.kind).toBe('unrecoverable');
  expect(downgradeCalled).toBe(false);
});

it('classify returns model_retry for recoverable model error with error context', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: { completed: Promise.resolve(undefined) } as any,
      retryCounts: baseCounts(),
    }),
  );

  expect(result.kind).toBe('model_retry');
  if (result.kind !== 'model_retry') return;
  expect(result.errorContext).toBeTruthy();
  expect(result.errorContext!.includes('fake_tool')).toBe(true);
});

it('classify returns model_retry without error context when stream produced no history', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      stream: null,
    }),
  );

  expect(result.kind).toBe('model_retry');
  if (result.kind !== 'model_retry') return;
  expect(result.errorContext).toBe(undefined);
});

it('classify returns unrecoverable when all retry limits are exhausted', () => {
  const classifier = makeClassifier({
    shouldRetryWithoutFlexServiceTier: () => true,
    forceTransportDowngrade: () => true,
  });

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      retryCounts: {
        transientRetryCount: 5,
        serviceTierFallbackCount: 1,
        modelRetryCount: 2,
        transportDowngradeCount: 1,
      },
    }),
  );

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable for generic non-retryable error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new Error('unknown') }));

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable for 400 status error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(baseContext({ error: new OpenAICompatibleError('bad request', 400, {}) }));

  expect(result).toEqual({ kind: 'unrecoverable' });
});

it('classify returns bounded chain recovery for previous_response_not_found websocket 400 payload', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Unexpected server response: 400 {"error":{"code":"previous_response_not_found","message":"Previous response not found"}}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error }))).toMatchObject({
    kind: 'chain_recovery',
    attempt: 1,
    cause: 'provider_state_rejected',
  });
});

it('classify returns bounded chain recovery for Invalid previous_response_id websocket 400 payload', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error }))).toMatchObject({ kind: 'chain_recovery', attempt: 1 });
});

it('classify returns transport_downgrade when the Responses websocket reaches its connection lifetime', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Responses websocket error: {"type":"error","error":{"type":"invalid_request_error","code":"websocket_connection_limit_reached","message":"Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."},"status":400}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error })).kind).toBe('transport_downgrade');
});

it('classify returns bounded chain recovery when a chained continuation is missing required tool output', () => {
  const classifier = makeClassifier();
  const error = new MissingChainedToolOutputError(['call-required']);

  expect(classifier.classify(baseContext({ error }))).toMatchObject({ kind: 'chain_recovery', attempt: 1 });
});

it('classify returns bounded chain recovery when a chained continuation has an orphaned tool output', () => {
  const classifier = makeClassifier();
  const error = new OrphanedChainedToolOutputError(['call-orphaned']);

  expect(classifier.classify(baseContext({ error }))).toMatchObject({ kind: 'chain_recovery', attempt: 1 });
});

it('classify returns bounded chain recovery for server missing tool output 400', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Error: {"type":"error","error":{"type":"invalid_request_error","message":"No tool output found for function call call_YaJm4jYEzyg2fIGYTMbjwez6.","param":"input"},"status":400}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error }))).toMatchObject({ kind: 'chain_recovery', attempt: 1 });
});

it('classify returns bounded chain recovery for server orphaned tool output 400', () => {
  const classifier = makeClassifier();
  const error = Object.assign(
    new Error(
      'Error: {"type":"error","error":{"type":"invalid_request_error","message":"No tool call found for function call output with call_id call_TPLbZgMcqd0guPBWHwDh1zjK.","param":"input"},"status":400}',
    ),
    { status: 400 },
  );

  expect(classifier.classify(baseContext({ error }))).toMatchObject({ kind: 'chain_recovery', attempt: 1 });
});

it('classify treats identical chain-recovery fingerprints as unrecoverable', () => {
  const classifier = makeClassifier();
  expect(classifier.classify(baseContext({ error: new ConversationStateNoProgressError() }))).toEqual({
    kind: 'unrecoverable',
  });
});

it('classify stops chain recovery after the transient retry budget is exhausted', () => {
  const classifier = makeClassifier();
  const error = new MissingChainedToolOutputError(['call-required']);

  expect(
    classifier.classify(
      baseContext({ error, maxTransientRetries: 1, retryCounts: { ...baseCounts(), transientRetryCount: 1 } }),
    ),
  ).toEqual({ kind: 'unrecoverable' });
});

it('classify permits a WebSocket connection-lifetime fallback only once', () => {
  const classifier = makeClassifier();
  const error = new Error('websocket_connection_limit_reached');

  expect(classifier.classify(baseContext({ error }))).toEqual({ kind: 'transport_downgrade' });
  expect(
    classifier.classify(baseContext({ error, retryCounts: { ...baseCounts(), transportDowngradeCount: 1 } })),
  ).toEqual({ kind: 'unrecoverable' });
});

it('classify returns transient for Codex WebSocket closed before terminal response', () => {
  const classifier = makeClassifier();
  const error = new Error('Codex WebSocket closed before a terminal response event.');

  expect(classifier.classify(baseContext({ error })).kind).toBe('transient');
});

it('classify leaves unrelated websocket 400 errors unrecoverable', () => {
  const classifier = makeClassifier();
  const error = Object.assign(new Error('Unexpected server response: 400 {"error":{"code":"invalid_request_error"}}'), {
    status: 400,
  });

  expect(classifier.classify(baseContext({ error }))).toEqual({ kind: 'unrecoverable' });
});

it('classify returns unrecoverable when model retry count exceeds max', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new ModelBehaviorError('Tool fake_tool not found'),
      retryCounts: { ...baseCounts(), modelRetryCount: 2 },
      maxModelRetries: 2,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify returns transient for undici onSocketClose TypeError mid-stream', () => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: baseCounts(),
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns transient when a chat stream ends without a finish reason', () => {
  // Regression: opencode/deepseek sometimes closes SSE after partial
  // reasoning with no finish_reason. The adapter correctly refuses to
  // synthesize completion; the classifier must treat that as recoverable.
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: new Error('OpenAI-compatible streamed response ended without a finish reason'),
      retryCounts: baseCounts(),
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns transient for ECONNRESET socket error', () => {
  const classifier = makeClassifier();

  const result = classifier.classify(
    baseContext({
      error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
});

it('classify returns unrecoverable when transient retries are exhausted', () => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: { ...baseCounts(), transientRetryCount: 5 },
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify returns unrecoverable for plain TypeError (non-undici) with empty message', () => {
  const classifier = makeClassifier();

  const plain = new TypeError();
  plain.stack = 'TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify transient attempt count increments with prior transient retries', () => {
  const classifier = makeClassifier();

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = ['TypeError', '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)'].join(
    '\n',
  );

  const result = classifier.classify(
    baseContext({
      error: undiciSocketClose,
      retryCounts: { ...baseCounts(), transientRetryCount: 2 },
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(3);
});

it('classify returns transient for re-wrapped undici onSocketClose (Error with message "TypeError")', () => {
  const classifier = makeClassifier();

  const rewrapped = new Error('TypeError');
  rewrapped.stack = [
    'Error: TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const result = classifier.classify(
    baseContext({
      error: rewrapped,
      retryCounts: baseCounts(),
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns unrecoverable for plain Error with message "TypeError" but no undici stack', () => {
  const classifier = makeClassifier();

  const plain = new Error('TypeError');
  plain.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';

  const result = classifier.classify(
    baseContext({
      error: plain,
      maxTransientRetries: 5,
    }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify recovers the chain when an ambiguous outcome wraps a flaky websocket close', () => {
  const classifier = makeClassifier();
  const error = new AmbiguousModelOutcomeError(
    'Codex WebSocket connection closed before a terminal response event. (code=1006 reason="" unsent=0)',
  );

  const result = classifier.classify(baseContext({ error }));

  expect(result).toMatchObject({ kind: 'chain_recovery', cause: 'connection_interrupted' });
});

it('classify keeps an ambiguous outcome unrecoverable when the server closed deliberately', () => {
  const classifier = makeClassifier();
  const error = new AmbiguousModelOutcomeError(
    'Codex WebSocket connection closed before a terminal response event. (code=1008 reason="policy violation" unsent=0)',
  );

  expect(classifier.classify(baseContext({ error })).kind).toBe('unrecoverable');
});

it('classify stops recovering a flaky close once the transient budget is spent', () => {
  const classifier = makeClassifier();
  const error = new AmbiguousModelOutcomeError(
    'Codex WebSocket connection closed before a terminal response event. (code=1006 reason="" unsent=0)',
  );

  const result = classifier.classify(
    baseContext({ error, retryCounts: { ...baseCounts(), transientRetryCount: 5 }, maxTransientRetries: 5 }),
  );

  expect(result.kind).toBe('unrecoverable');
});

it('classify returns transient for in-stream 429 rate limit error frame', () => {
  const classifier = makeClassifier();
  const error = {
    code: 429,
    message: 'Provider returned error',
    metadata: { error_type: 'rate_limit_exceeded' },
  };

  const result = classifier.classify(baseContext({ error }));

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
  expect(result.delayMs > 0 && result.delayMs <= 30000).toBe(true);
});

it('classify returns transient for OpenRouter / upstream 503 error', () => {
  const classifier = makeClassifier();
  const error = new OpenAICompatibleError('service unavailable', 503, {});

  const result = classifier.classify(baseContext({ error }));

  expect(result.kind).toBe('transient');
  if (result.kind !== 'transient') return;
  expect(result.attempt).toBe(1);
});
