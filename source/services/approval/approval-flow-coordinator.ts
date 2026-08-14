import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { ApprovalState, type AbortedApprovalContext, type PendingApprovalContext } from './approval-state.js';
import { markToolCallAsApprovalRejection } from '../../utils/streaming/extract-command-messages.js';
import { getCallIdFromObject } from '../interruption-info.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { SessionToolTracker } from '../session/session-tool-tracker.js';
import { GenerationGuard } from '../generation-guard.js';
import type { ToolOwner } from './tool-owner.js';
import { ToolOwnershipRegistry } from './tool-ownership-registry.js';
import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import { ApprovalDecisionExecutor, type ApprovalDecisionSource } from './approval-decision-executor.js';

export interface ApprovalFlowCoordinatorDeps {
  agentClient: ConversationAgentClient;
  approvalState: ApprovalState;
  logger: ILoggingService;
  sessionId: string;
  toolTracker: SessionToolTracker;
  generationGuard: GenerationGuard;
  /** Session-owned registry shared with nested subagent runners. */
  toolOwnership: ToolOwnershipRegistry;
  /** Handle-owned root capability; omitted only by nested compatibility fixtures. */
  sessionAccess?: SessionAccessState;
  /** Explicit nested/test-only legacy approval state. */
  nestedCompatibility?: NestedToolCompatibilityState;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
}

export interface AbortResolutionPlan {
  abortedContext: AbortedApprovalContext;
}

export interface ContinuationPlan {
  pendingApprovalContext: PendingApprovalContext;
  toolStartedEvent?: ConversationEvent;
}

export type ApprovalDecisionInput = {
  kind: 'approval_decision';
  answer: string;
  rejectionReason?: string;
  generation: number;
  stopAfterApprovalResolution?: boolean;
};

export class ApprovalFlowCoordinator {
  readonly #toolOwnership: ToolOwnershipRegistry;
  readonly #decisionExecutor: ApprovalDecisionExecutor;

  constructor(private readonly deps: ApprovalFlowCoordinatorDeps) {
    this.#toolOwnership = deps.toolOwnership;
    this.#decisionExecutor = new ApprovalDecisionExecutor({
      logger: deps.logger,
      sessionId: deps.sessionId,
      toolOwnership: deps.toolOwnership,
      sessionAccess: deps.sessionAccess,
      nestedCompatibility: deps.nestedCompatibility,
      hookLifecycle: deps.hookLifecycle,
      hookEvents: deps.hookEvents,
    });
  }

  /**
   * Which agent issued this pending tool call. A subagent claims its own
   * approvals when it raises them; anything unclaimed is the parent's.
   */
  resolveOwner(interruption: unknown): ToolOwner {
    return this.#toolOwnership.ownerOf(getCallIdFromObject(interruption));
  }

  buildApprovalDecision(
    answer: string,
    rejectionReason?: string,
    stopAfterApprovalResolution?: boolean,
  ): ApprovalDecisionInput {
    return {
      kind: 'approval_decision',
      answer,
      rejectionReason,
      generation: this.deps.approvalState.getPending()?.token ?? 0,
      ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
    };
  }

  abort(): { aborted: boolean; callId?: string } {
    this.deps.agentClient.abort();
    const pending = this.deps.approvalState.getPending();
    const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
    if (this.deps.approvalState.abortPending()) {
      if (callId) this.#toolOwnership.release(callId);
      this.deps.toolTracker.markOpenCallsAborted('Tool execution was not approved.', callId);
      this.deps.logger.debug('Aborted approval - abandoning pending tool before next message', {
        eventType: 'approval.aborted',
        category: 'approval',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });
      return { aborted: true, callId };
    }
    return { aborted: false };
  }

  consumeAborted(): AbortedApprovalContext | null {
    return this.deps.approvalState.consumeAborted();
  }

  getAbortedStatus(): { kind: 'none' } | { kind: 'current'; context: AbortedApprovalContext } | { kind: 'stale' } {
    const aborted = this.deps.approvalState.consumeAborted();
    if (!aborted) {
      return { kind: 'none' };
    }
    const tokenVal = aborted.token ?? 0;
    if (this.deps.generationGuard.isCurrent(tokenVal)) {
      return { kind: 'current', context: aborted };
    }
    return { kind: 'stale' };
  }

  /**
   * Drive an aborted-approval resolution: install rejection interceptor and approve the
   * interruption so the agent gets the rejection text via the interceptor.
   * For nested subagent approvals, use SDK-native reject() instead of the
   * parent interceptor path to avoid interceptor stacking issues.
   */
  prepareAbortResolution(abortedContext: AbortedApprovalContext, userText: string): AbortResolutionPlan {
    const expectedCallId = getCallIdFromObject(abortedContext.interruption);
    const rejectionMessage = `Tool execution was not approved. User provided new input instead: ${userText}`;

    markToolCallAsApprovalRejection(expectedCallId);

    abortedContext.state.reject?.(abortedContext.interruption as any, { message: rejectionMessage });
    abortedContext.decisionsByCallId ??= new Map();
    if (expectedCallId) {
      abortedContext.decisionsByCallId.set(expectedCallId, 'rejected');
    }

    return { abortedContext };
  }

  /**
   * Prepare for a continuation after the user makes an approval decision.
   * Returns null if there is no pending approval.
   */
  prepareContinuation(
    answer: string,
    rejectionReason: string | undefined,
    source: ApprovalDecisionSource = 'user',
  ): ContinuationPlan | null {
    const pendingApprovalContext = this.deps.approvalState.getPending();
    if (!pendingApprovalContext) {
      return null;
    }

    const result = this.#decisionExecutor.resolve({
      pendingApprovalContext,
      answer,
      rejectionReason,
      source,
    });
    return { pendingApprovalContext, toolStartedEvent: result.toolStartedEvent };
  }

  recordPending(pending: PendingApprovalContext): void {
    this.deps.approvalState.setPending(pending);
  }

  clearPending(): void {
    this.deps.approvalState.clearPending();
  }

  getPending(): PendingApprovalContext | null {
    return this.deps.approvalState.getPending();
  }

  getPendingInterruption(): unknown {
    return this.deps.approvalState.getPending()?.interruption;
  }

  retargetPendingInterruption(interruption: unknown): PendingApprovalContext | null {
    const pending = this.deps.approvalState.getPending();
    if (!pending) {
      return null;
    }

    this.deps.approvalState.setPending({
      ...pending,
      interruption,
      promptedCallId: getCallIdFromObject(interruption),
      owner: this.resolveOwner(interruption),
    });
    return this.deps.approvalState.getPending();
  }
}
