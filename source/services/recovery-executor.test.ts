import test from 'ava';
import { ConversationStore } from './conversation-store.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import type { RetryCounts, RecoveryState } from './retry-contracts.js';
import { DefaultRecoveryExecutor, type RecoveryExecutorDeps } from './recovery-executor.js';
import { ProviderContinuity } from './provider-continuity.js';
import { SessionToolTracker } from './session-tool-tracker.js';

const baseCounts = (): RetryCounts => ({
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
});

const makeExecutor = (): { executor: DefaultRecoveryExecutor; deps: RecoveryExecutorDeps } => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const providerContinuity = new ProviderContinuity();
  const deps: RecoveryExecutorDeps = { toolTracker, conversationStore, providerContinuity };
  const executor = new DefaultRecoveryExecutor(deps);
  return { executor, deps };
};

const baseRecoveryState = (overrides: Partial<RecoveryState> = {}): RecoveryState => ({
  ledgerSnapshot: [],
  addedUserMessage: false,
  stream: null,
  ...overrides,
});

test('resume_stream returns run instruction with resume state', (t) => {
  const { executor } = makeExecutor();
  const mockState = { _currentTurn: 'x' } as any;

  const result = executor.apply(
    { kind: 'resume_stream', state: mockState, previousResponseId: 'resp-1' },
    baseRecoveryState(),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  if (result.kind !== 'run') return;
  t.true(result.instruction.skipUserMessage);
  t.is(result.instruction.resumeState, mockState);
  t.is(result.instruction.resumePreviousResponseId, 'resp-1');
});

test('replay_turn with rollback removes user message and clears continuity', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply(
    { kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: true },
    baseRecoveryState({ addedUserMessage: true }),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  t.is(deps.providerContinuity.previousResponseId, null);
  t.is(deps.conversationStore.getHistory().length, 0);
  if (result.kind !== 'run') return;
  t.false(result.instruction.skipUserMessage);
});

test('replay_turn without rollback keeps user message', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply(
    { kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: false },
    baseRecoveryState({ addedUserMessage: true }),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  t.is(deps.conversationStore.getHistory().length, 1);
  if (result.kind !== 'run') return;
  t.true(result.instruction.skipUserMessage);
});

test('replay_turn with errorContext injects error context into conversation store', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  executor.apply(
    {
      kind: 'replay_turn',
      inputMode: 'full_history',
      rollbackUserMessage: false,
      errorContext: 'Previous attempt failed',
    },
    baseRecoveryState({ addedUserMessage: true }),
    baseCounts(),
  );

  const history = deps.conversationStore.getHistory();
  const errorItem = history.find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'content' in item &&
      typeof (item as any).content === 'string' &&
      (item as any).content.includes('Previous attempt failed'),
  );
  t.truthy(errorItem, 'should have injected error context into history');
});

test('retry_fresh with stream reconciles history and restores ledger', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const completedEntry: SavedToolExecution = {
    turnId: 'turn-1',
    callId: 'call-read',
    toolName: 'read_file',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    historyItems: [],
  };

  const result = executor.apply(
    { kind: 'retry_fresh', inputMode: 'full_history' },
    baseRecoveryState({ stream: { completed: Promise.resolve(undefined) } as any, ledgerSnapshot: [completedEntry] }),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  t.is(deps.providerContinuity.previousResponseId, null);
});

test('retry_fresh without stream removes user message and clears continuity', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply(
    { kind: 'retry_fresh', inputMode: 'full_history' },
    baseRecoveryState({ addedUserMessage: true, stream: null }),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  t.is(deps.providerContinuity.previousResponseId, null);
  t.is(deps.conversationStore.getHistory().length, 0);
});

test('retry_fresh with useStandardServiceTier passes flag through', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply(
    { kind: 'retry_fresh', inputMode: 'delta', useStandardServiceTier: true },
    baseRecoveryState({ addedUserMessage: true, stream: null }),
    baseCounts(),
  );

  t.is(result.kind, 'run');
  if (result.kind !== 'run') return;
  t.true(result.useStandardServiceTier);
});

test('terminate removes user message when added without stream', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply(
    { kind: 'terminate', events: [{ type: 'error', message: 'failed' }] },
    baseRecoveryState({ addedUserMessage: true, stream: null }),
    baseCounts(),
  );

  t.is(result.kind, 'terminated');
  t.is(deps.conversationStore.getHistory().length, 0);
  if (result.kind !== 'terminated') return;
  t.is(result.events.length, 1);
  t.is(result.events[0].type, 'error');
});

test('terminate with stream marks open calls aborted and reconciles history', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply(
    { kind: 'terminate', events: [{ type: 'error', message: 'stream failed' }] },
    baseRecoveryState({ addedUserMessage: true, stream: { completed: Promise.resolve(undefined) } as any }),
    baseCounts(),
  );

  t.is(result.kind, 'terminated');
  if (result.kind !== 'terminated') return;
  t.is(result.events[0].type, 'error');
});

test('terminate includes tool_recovery event when there are recovered calls', (t) => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.toolTracker.ledger.recordFunctionCall({
    type: 'function_call',
    callId: 'call-1',
    name: 'shell',
    arguments: '{}',
  });
  deps.toolTracker.ledger.recordAbortedApproval('aborted', 'aborted', 'call-1');

  const result = executor.apply(
    { kind: 'terminate', events: [] },
    baseRecoveryState({ stream: { completed: Promise.resolve(undefined) } as any }),
    baseCounts(),
  );

  t.is(result.kind, 'terminated');
  if (result.kind !== 'terminated') return;
  const recoveryEvent = result.events.find((e) => e.type === 'tool_recovery');
  t.truthy(recoveryEvent);
});
