import { it, expect } from 'vitest';
import { TurnCoordinator } from './turn-coordinator.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import {
  isTerm2HookEvent,
  type Term2HookEvent,
  type TurnStartHookEvent,
  type TurnEndHookEvent,
} from '../hooks/hook-contracts.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

/**
 * The coordinator harness mirrors `turn-coordinator.test.ts` composition:
 * a real TurnStatusMachine, a workflow double that returns selected modeled
 * outcomes, and stubs for approval flow, continuity, and shell auto approval.
 * The hook lifecycle is real-shaped so the public hook projection is actually
 * emitted: events are captured from `HookLifecyclePort.emit`, never from
 * private coordinator fields.
 */
const makeHarness = () => {
  const statusMachine = new TurnStatusMachine();

  const initialCalls: any[] = [];
  const continuationCalls: any[] = [];
  const initialResults: any[] = [];
  const continuationResults: any[] = [];
  const turnScope: string[] = [];
  let liveRunAborted = false;
  const turnWorkflow = {
    openTurn: () => turnScope.push('open'),
    closeTurn: () => turnScope.push('close'),
    executeInitial: async function* (input: any, options: any) {
      turnScope.push('executeInitial');
      initialCalls.push({ input, options });
      const result = initialResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    executeContinuation: async function* (init: any) {
      turnScope.push('executeContinuation');
      continuationCalls.push(init);
      const result = continuationResults.shift();
      if (result?.events) {
        for (const ev of result.events) {
          yield ev;
        }
      }
      return result?.outcome ?? { kind: 'response', terminal: { type: 'response', finalText: 'done' } };
    },
    setNextInitialResult: (outcome: any, events: any[] = []) => {
      initialResults.push({ outcome, events });
    },
    setNextContinuationResult: (outcome: any, events: any[] = []) => {
      continuationResults.push({ outcome, events });
    },
    setHookTurnId: () => {},
    abortLiveRun: () => {
      liveRunAborted = true;
    },
  } as any;

  const captured: Term2HookEvent[] = [];
  const hookLifecycle: HookLifecyclePort = {
    emit: async (event) => {
      captured.push(event);
    },
    shutdown: async () => {},
  };
  const hookEvents = new HookEventFactory({ sessionId: 'sb01' });

  const getPendingResult: any = null;
  const approvalFlow = {
    getAbortedStatus: () => ({ kind: 'none' }),
    buildApprovalDecision: (answer: string, rejectionReason?: string, stopAfterApprovalResolution?: boolean) => ({
      kind: 'approval_decision',
      answer,
      rejectionReason,
      stopAfterApprovalResolution,
      generation: getPendingResult?.token ?? 0,
    }),
    getPending: () => getPendingResult,
    abort: () => ({ aborted: true, callId: 'call-1' }),
  } as any;

  const providerContinuity = {
    clear: () => {},
  } as any;

  const shellAutoApproval = {
    recordManualDecision: () => {},
  } as any;

  const coordinator = new TurnCoordinator({
    statusMachine,
    turnWorkflow,
    approvalFlow,
    providerContinuity,
    shellAutoApproval,
    hookLifecycle,
    hookEvents,
  });

  return {
    coordinator,
    statusMachine,
    turnWorkflow,
    approvalFlow,
    captured,
    getLiveRunAborted: () => liveRunAborted,
  };
};

const drain = async (iterable: AsyncIterable<ConversationEvent>): Promise<void> => {
  for await (const _ of iterable) {
    // events are observed only through the hook lifecycle capture
  }
};

it('emits a hook-contract-valid turn.end for every modeled outcome', async () => {
  // Separate fresh harnesses: each modeled outcome is projected through the
  // coordinator once, so a future exhaustive/narrower workflow outcome repair
  // cannot break hook payloads for legitimate outcomes.
  const cases = [
    {
      kind: 'response' as const,
      outcome: { kind: 'response' as const, terminal: { type: 'response' as const, finalText: 'done' } },
    },
    {
      kind: 'approval_required' as const,
      outcome: {
        kind: 'approval_required' as const,
        terminal: { type: 'approval_required' as const, approval: { toolName: 'shell', argumentsText: 'ls' } },
      },
    },
    { kind: 'stale' as const, outcome: { kind: 'stale' as const } },
    { kind: 'failed' as const, outcome: { kind: 'failed' as const } },
  ];

  for (const testCase of cases) {
    const { coordinator, turnWorkflow, captured } = makeHarness();
    turnWorkflow.setNextInitialResult(testCase.outcome);
    await drain(coordinator.start('run command'));

    const turnEnd = captured.find((event) => event.type === 'turn.end');
    expect(turnEnd, `modeled ${testCase.kind} must project a turn.end`).toBeDefined();
    expect(isTerm2HookEvent(turnEnd)).toBe(true);
    expect((turnEnd as TurnEndHookEvent).terminalKind).toBe(testCase.kind);
  }
});

it('keeps one hook turn id across an approval pause and its continuation', async () => {
  const { coordinator, turnWorkflow, captured } = makeHarness();
  turnWorkflow.setNextInitialResult({
    kind: 'approval_required',
    terminal: { type: 'approval_required', approval: { toolName: 'shell', argumentsText: 'ls' } },
  });
  await drain(coordinator.start('run command'));

  turnWorkflow.setNextContinuationResult({
    kind: 'response',
    terminal: { type: 'response', finalText: 'done' },
  });
  await drain(coordinator.continueAfterApproval({ answer: 'y' }));

  const starts = captured.filter((event): event is TurnStartHookEvent => event.type === 'turn.start');
  const ends = captured.filter((event): event is TurnEndHookEvent => event.type === 'turn.end');

  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(2);

  const turnId = starts[0]!.turnId;
  expect(turnId).toBeTruthy();
  expect(ends[0]!.turnId).toBe(turnId);
  expect(ends[1]!.turnId).toBe(turnId);
  expect(ends[0]!.terminalKind).toBe('approval_required');
  expect(ends[1]!.terminalKind).toBe('response');
});
