import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { ApprovalState, type AbortedApprovalContext, type PendingApprovalContext } from './approval-state.js';
import { markToolCallAsApprovalRejection } from '../../utils/streaming/extract-command-messages.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { createInvalidToolCallDiagnostic } from '../logging/logging-contract.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { SessionToolTracker } from '../session/session-tool-tracker.js';
import { GenerationGuard } from '../generation-guard.js';

const noop = () => undefined;

export interface ApprovalFlowCoordinatorDeps {
  agentClient: ConversationAgentClient;
  approvalState: ApprovalState;
  logger: ILoggingService;
  sessionId: string;
  toolTracker: SessionToolTracker;
  generationGuard: GenerationGuard;
}

export interface AbortResolutionPlan {
  abortedContext: AbortedApprovalContext;
  /** Cleanup that removes the rejection interceptor; always safe to call. */
  removeInterceptor: () => void;
}

export interface ContinuationPlan {
  pendingApprovalContext: PendingApprovalContext;
  toolStartedEvent?: ConversationEvent;
  /** Cleanup that removes the rejection interceptor; always safe to call. */
  removeInterceptor: () => void;
}

export class ApprovalFlowCoordinator {
  constructor(private readonly deps: ApprovalFlowCoordinatorDeps) {}

  abort(): { aborted: boolean; callId?: string } {
    this.deps.agentClient.abort();
    const pending = this.deps.approvalState.getPending();
    const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
    if (this.deps.approvalState.abortPending()) {
      this.deps.toolTracker.recordAbortedApproval(
        'Tool execution was not approved.',
        'Tool execution was not approved.',
        callId,
      );
      this.deps.logger.debug('Aborted approval - will handle rejection on next message', {
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

    abortedContext.state.reject(abortedContext.interruption as any, { message: rejectionMessage });

    return { abortedContext, removeInterceptor: noop };
  }

  /**
   * Prepare for a continuation after the user makes an approval decision.
   * Returns null if there is no pending approval. Caller is responsible for invoking
   * `removeInterceptor` in a finally block once the continuation stream completes.
   */
  prepareContinuation(answer: string, rejectionReason: string | undefined): ContinuationPlan | null {
    const pendingApprovalContext = this.deps.approvalState.getPending();
    if (!pendingApprovalContext) {
      return null;
    }

    const { state, interruption } = pendingApprovalContext;

    let toolStartedEvent: ConversationEvent | undefined;

    if (answer === 'y') {
      this.deps.logger.debug('Tool approval granted', {
        eventType: 'approval.granted',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });

      const { toolName, rawArguments } = getToolInfoFromInterruption(interruption);
      const callId = getCallIdFromObject(interruption);

      const parseResult = parseToolCallArguments(rawArguments, {
        callId: callId ?? String(Date.now()),
        toolName,
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
      });

      if (parseResult.invalidJsonDiagnostic) {
        const diagnostic = createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic);
        this.deps.logger.error('Invalid tool call argument payload', {
          ...diagnostic,
          sessionId: this.deps.sessionId,
          messageId: callId ?? String(Date.now()),
        });
      }

      const toolCallId = callId ?? String(Date.now());
      toolStartedEvent =
        pendingApprovalContext.owner.kind === 'subagent'
          ? {
              type: 'subagent_tool_started',
              agentId: pendingApprovalContext.owner.agentId,
              role: pendingApprovalContext.owner.role,
              toolCallId,
              toolName,
              arguments: parseResult.arguments,
            }
          : {
              type: 'tool_started',
              toolCallId,
              toolName,
              arguments: parseResult.arguments,
            };

      state.approve(interruption as any);
    } else {
      const expectedCallId = getCallIdFromObject(interruption);
      const rejectionMessage = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';

      markToolCallAsApprovalRejection(expectedCallId);

      state.reject?.(interruption as any, { message: rejectionMessage });

      this.deps.logger.debug('Tool approval rejected', {
        eventType: 'approval.rejected',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });
    }

    const removeInterceptor = noop;

    return { pendingApprovalContext, toolStartedEvent, removeInterceptor };
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
}
