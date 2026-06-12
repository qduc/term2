import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ILoggingService } from '../service-interfaces.js';
import { getCallIdFromObject } from '../interruption-info.js';
import type { ContinuationInit } from './continuation-driver.js';
import type { ContinuationState, PreparedContinuation } from './continuation-state.js';
import type { ContinuationPlan } from '../approval/approval-flow-coordinator.js';
import type { ApprovalContext } from '../approval/approval-decision-policy.js';

export type ContinuationPlanApplierDeps = {
  approvalFlow: ApprovalFlowCoordinator;
  toolTracker: SessionToolTracker;
  logger: ILoggingService;
  sessionId: string;
};

export class ContinuationPlanApplier {
  constructor(private readonly deps: ContinuationPlanApplierDeps) {}

  prepareInit(init: ContinuationInit): PreparedContinuation {
    if (init.kind === 'approval_decision') {
      const plan = this.deps.approvalFlow.prepareContinuation(init.answer, init.rejectionReason);
      if (!plan) {
        throw new Error('No pending approval for continuation');
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
        previouslyEmittedCommandIds: plan.pendingApprovalContext.emittedCommandIds,
        toolStartedEvent: plan.toolStartedEvent,
        removeInterceptor: plan.removeInterceptor,
        source: 'continueRunStream',
        token: plan.pendingApprovalContext.token,
        inputMode: plan.pendingApprovalContext.inputMode,
        cumulativeUsage: plan.pendingApprovalContext.cumulativeUsage,
        cumulativeCommandMessages: plan.pendingApprovalContext.cumulativeCommandMessages,
        cumulativeTurnItems: plan.pendingApprovalContext.cumulativeTurnItems,
      };
    }

    const { abortedContext } = init;
    const plan = this.deps.approvalFlow.prepareAbortResolution(abortedContext, init.userText);

    return {
      state: abortedContext.state,
      interruption: abortedContext.interruption,
      toolCallArgumentsById: abortedContext.toolCallArgumentsById,
      previouslyEmittedCommandIds: abortedContext.emittedCommandIds,
      toolStartedEvent: undefined,
      removeInterceptor: plan.removeInterceptor,
      source: 'abortResolution',
      token: abortedContext.token,
      inputMode: abortedContext.inputMode,
      cumulativeUsage: abortedContext.cumulativeUsage,
      cumulativeCommandMessages: abortedContext.cumulativeCommandMessages,
      cumulativeTurnItems: abortedContext.cumulativeTurnItems,
    };
  }

  async *applyInitialSetup(
    prepared: PreparedContinuation,
    state: ContinuationState,
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

    state.setLedgerSnapshot(this.deps.toolTracker.export());
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
    state: ContinuationState,
    mergedEmittedIds: Set<string>,
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
      nextPlan.pendingApprovalContext.interruption,
      nextPlan.pendingApprovalContext.inputMode,
      mergedEmittedIds,
      this.deps.toolTracker.export(),
    );
  }
}
