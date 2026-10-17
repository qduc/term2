import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ILoggingService } from '../service-interfaces.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { isRunBudgetInteraction } from '../agent-runtime/run-budget.js';
import type { ContinuationInit, TurnProjectionState, PreparedContinuation } from './turn-projection-state.js';
import type { ContinuationPlan } from '../approval/approval-flow-coordinator.js';
import type { ApprovalContext } from '../approval/approval-decision-policy.js';
import type { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import type { SessionIdSource } from './session-identity.js';

export type ContinuationPlanApplierDeps = {
  approvalFlow: ApprovalFlowCoordinator;
  toolTracker: SessionToolTracker;
  logger: ILoggingService;
  sessionId: SessionIdSource;
  journal: AssistantTurnJournal;
};

export class ContinuationPlanApplier {
  constructor(private readonly deps: ContinuationPlanApplierDeps) {}

  prepareInit(init: ContinuationInit): PreparedContinuation {
    if (init.kind === 'approval_decision') {
      const plan = this.deps.approvalFlow.prepareContinuation(init.answer, init.rejectionReason);
      if (!plan) {
        throw new Error('No pending approval for continuation');
      }

      // Budget evidence uses the continuation transport but is not a tool
      // approval. Tell the retained run whether to continue or settle; do not
      // manufacture a tool_started event or run normal approval policy.
      if (isRunBudgetInteraction(plan.pendingApprovalContext.interruption)) {
        if (init.answer === 'y') plan.pendingApprovalContext.state.approve?.(plan.pendingApprovalContext.interruption);
        else plan.pendingApprovalContext.state.reject?.(plan.pendingApprovalContext.interruption);
        return {
          state: plan.pendingApprovalContext.state,
          interruption: plan.pendingApprovalContext.interruption,
          toolCallArgumentsById: plan.pendingApprovalContext.toolCallArgumentsById,
          toolStartedEvent: undefined,
          source: 'continueRunStream',
          inputMode: plan.pendingApprovalContext.inputMode,
        };
      }

      if (init.answer !== 'y') {
        const callId = getCallIdFromObject(plan.pendingApprovalContext.interruption);
        const output = init.rejectionReason
          ? `Tool execution was not approved. User's reason: ${init.rejectionReason}`
          : 'Tool execution was not approved.';
        this.deps.toolTracker.recordAbortedApproval(output, output, callId);
      }

      return {
        state: plan.pendingApprovalContext.state,
        interruption: plan.pendingApprovalContext.interruption,
        toolCallArgumentsById: plan.pendingApprovalContext.toolCallArgumentsById,
        toolStartedEvent: plan.toolStartedEvent,
        source: 'continueRunStream',
        inputMode: plan.pendingApprovalContext.inputMode,
      };
    }

    const { abortedContext } = init;
    this.deps.approvalFlow.prepareAbortResolution(abortedContext, init.userText);

    return {
      state: abortedContext.state,
      interruption: abortedContext.interruption,
      toolCallArgumentsById: abortedContext.toolCallArgumentsById,
      toolStartedEvent: undefined,
      source: 'abortResolution',
      inputMode: abortedContext.inputMode,
    };
  }

  async *applyInitialSetup(
    prepared: PreparedContinuation,
    state: TurnProjectionState,
  ): AsyncGenerator<ConversationEvent, void, void> {
    if (prepared.toolStartedEvent) {
      const filtered = this.deps.toolTracker.dedupeToolStarted(prepared.toolStartedEvent);
      if (filtered) yield filtered;
    }

    this.deps.toolTracker.clearArguments();
    if (prepared.toolCallArgumentsById?.size) {
      for (const [key, value] of prepared.toolCallArgumentsById.entries()) {
        this.deps.toolTracker.argumentsById.set(key, value);
      }
    }

    state.setJournalSnapshot(this.deps.journal.getEvents());
  }

  recordPendingApproval(context: ApprovalContext): void {
    if (!context.callId) {
      return;
    }

    this.deps.toolTracker.recordFunctionCall({
      type: 'function_call',
      callId: context.callId,
      name: context.toolName,
      arguments: context.argumentsText,
    });
  }

  async *applyNextPlan(
    nextPlan: ContinuationPlan,
    state: TurnProjectionState,
    isApproved: boolean,
  ): AsyncGenerator<ConversationEvent, void, void> {
    if (!isApproved) {
      const callId = getCallIdFromObject(nextPlan.pendingApprovalContext.interruption);
      this.deps.toolTracker.recordAbortedApproval(
        'Tool execution was not approved.',
        'Tool execution was not approved.',
        callId,
      );
    }

    if (nextPlan.toolStartedEvent) {
      const filtered = this.deps.toolTracker.dedupeToolStarted(nextPlan.toolStartedEvent);
      if (filtered) yield filtered;
    }

    this.deps.toolTracker.clearArguments();
    if (nextPlan.pendingApprovalContext.toolCallArgumentsById?.size) {
      for (const [key, value] of nextPlan.pendingApprovalContext.toolCallArgumentsById.entries()) {
        this.deps.toolTracker.argumentsById.set(key, value);
      }
    }

    state.advanceFromPlan(
      nextPlan.pendingApprovalContext.state,
      nextPlan.pendingApprovalContext.inputMode,
      this.deps.journal.getEvents(),
      this.deps.toolTracker.activeCallIdsForCurrentTurn(),
    );
  }
}
