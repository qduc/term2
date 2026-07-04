import { it, expect } from 'vitest';
import { ConversationStore } from '../conversation/conversation-store.js';
import type { RetryCounts, RecoveryState } from './retry-contracts.js';
import { DefaultRecoveryExecutor, type RecoveryExecutorDeps } from './recovery-executor.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { SessionToolTracker } from '../session/session-tool-tracker.js';

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
  journalSnapshot: [],
  addedUserMessage: false,
  stream: null,
  ...overrides,
});

it('resume_stream returns run instruction with resume state', () => {
  const { executor } = makeExecutor();
  const mockState = { _currentTurn: 'x' } as any;

  const result = executor.apply({
    plan: { kind: 'resume_stream', state: mockState, previousResponseId: 'resp-1' },
    state: baseRecoveryState(),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  if (result.kind !== 'run') return;
  expect(result.instruction.skipUserMessage).toBe(true);
  expect(result.instruction.resumeState).toBe(mockState);
  expect(result.instruction.resumePreviousResponseId).toBe('resp-1');
});

it('replay_turn with rollback removes user message and clears continuity', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply({
    plan: { kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: true },
    state: baseRecoveryState({ addedUserMessage: true }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  expect(deps.providerContinuity.previousResponseId).toBe(null);
  expect(deps.conversationStore.getHistory().length).toBe(0);
  if (result.kind !== 'run') return;
  expect(result.instruction.skipUserMessage).toBe(false);
});

it('replay_turn without rollback keeps user message', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply({
    plan: { kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: false },
    state: baseRecoveryState({ addedUserMessage: true }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  expect(deps.conversationStore.getHistory().length).toBe(1);
  if (result.kind !== 'run') return;
  expect(result.instruction.skipUserMessage).toBe(true);
});

it('replay_turn with errorContext injects error context into conversation store', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  executor.apply({
    plan: {
      kind: 'replay_turn',
      inputMode: 'full_history',
      rollbackUserMessage: false,
      errorContext: 'Previous attempt failed',
    },
    state: baseRecoveryState({ addedUserMessage: true }),
    retryCounts: baseCounts(),
  });

  const history = deps.conversationStore.getHistory();
  const errorItem = history.find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'content' in item &&
      typeof (item as any).content === 'string' &&
      (item as any).content.includes('Previous attempt failed'),
  );
  expect(errorItem).toBeTruthy();
});

it('retry_fresh with stream reconciles history and restores ledger', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply({
    plan: { kind: 'retry_fresh', inputMode: 'full_history' },
    state: baseRecoveryState({
      stream: { completed: Promise.resolve(undefined) } as any,
      journalSnapshot: [
        {
          type: 'assistant_journal_item',
          turnId: 'turn-1',
          seq: 1,
          item: {
            type: 'tool_call',
            callId: 'call-read',
            toolName: 'read_file',
            arguments: '{}',
          },
        },
        {
          type: 'assistant_journal_item',
          turnId: 'turn-1',
          seq: 2,
          item: {
            type: 'tool_result',
            callId: 'call-read',
            toolName: 'read_file',
            status: 'completed',
            output: 'contents',
          },
        },
      ],
    }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  expect(deps.providerContinuity.previousResponseId).toBe(null);
});

it('retry_fresh without stream preserves user message and clears continuity', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply({
    plan: { kind: 'retry_fresh', inputMode: 'full_history' },
    state: baseRecoveryState({ addedUserMessage: true, stream: null }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  expect(deps.providerContinuity.previousResponseId).toBe(null);
  expect(deps.conversationStore.getHistory().length).toBe(1);
});

it('retry_fresh with useStandardServiceTier passes flag through', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.providerContinuity.update('resp-old');

  const result = executor.apply({
    plan: { kind: 'retry_fresh', inputMode: 'delta', useStandardServiceTier: true },
    state: baseRecoveryState({ addedUserMessage: true, stream: null }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('run');
  if (result.kind !== 'run') return;
  expect(result.useStandardServiceTier).toBe(true);
});

it('terminate removes user message when added without stream', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply({
    plan: { kind: 'terminate', events: [{ type: 'error', message: 'failed' }] },
    state: baseRecoveryState({ addedUserMessage: true, stream: null }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('terminated');
  expect(deps.conversationStore.getHistory().length).toBe(0);
  if (result.kind !== 'terminated') return;
  expect(result.events.length).toBe(1);
  expect(result.events[0].type).toBe('error');
});

it('terminate with stream marks open calls aborted and reconciles history', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');

  const result = executor.apply({
    plan: { kind: 'terminate', events: [{ type: 'error', message: 'stream failed' }] },
    state: baseRecoveryState({ addedUserMessage: true, stream: { completed: Promise.resolve(undefined) } as any }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('terminated');
  if (result.kind !== 'terminated') return;
  expect(result.events[0].type).toBe('error');
});

it('terminate includes tool_recovery event when there are recovered calls', () => {
  const { executor, deps } = makeExecutor();
  deps.conversationStore.addUserMessage('hello');
  deps.toolTracker.ledger.recordFunctionCall({
    type: 'function_call',
    callId: 'call-1',
    name: 'shell',
    arguments: '{}',
  });
  deps.toolTracker.ledger.recordAbortedApproval('aborted', 'aborted', 'call-1');

  const result = executor.apply({
    plan: { kind: 'terminate', events: [] },
    state: baseRecoveryState({ stream: { completed: Promise.resolve(undefined) } as any }),
    retryCounts: baseCounts(),
  });

  expect(result.kind).toBe('terminated');
  if (result.kind !== 'terminated') return;
  const recoveryEvent = result.events.find((e) => e.type === 'tool_recovery');
  expect(recoveryEvent).toBeTruthy();
});
