import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import { ApprovalState, type AbortedApprovalContext, type PendingApprovalContext } from './approval-state.js';
import {
  installApprovalRejectionInterceptor,
  tryInstallApprovalRejectionInterceptor,
} from './approval-rejection-interceptor.js';
import {
  asRecord,
  getCallIdFromObject,
  getMethod,
  getString,
  getToolInfoFromInterruption,
} from './interruption-info.js';

const noop = () => undefined;

export interface ApprovalFlowCoordinatorDeps {
  agentClient: OpenAIAgentClient;
  approvalState: ApprovalState;
  logger: ILoggingService;
  sessionId: string;
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

  abort(): boolean {
    this.deps.agentClient.abort();
    if (this.deps.approvalState.abortPending()) {
      this.deps.logger.debug('Aborted approval - will handle rejection on next message', {
        eventType: 'approval.aborted',
        category: 'approval',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });
      return true;
    }
    return false;
  }

  consumeAborted(): AbortedApprovalContext | null {
    return this.deps.approvalState.consumeAborted();
  }

  /**
   * Drive an aborted-approval resolution: install rejection interceptor and approve the
   * interruption so the agent gets the rejection text via the interceptor.
   */
  prepareAbortResolution(abortedContext: AbortedApprovalContext, userText: string): AbortResolutionPlan {
    const interruptionRecord = asRecord(abortedContext.interruption);
    const toolName = getString(interruptionRecord, 'name') ?? 'unknown';
    const expectedCallId = getCallIdFromObject(abortedContext.interruption);
    const rejectionMessage = `Tool execution was not approved. User provided new input instead: ${userText}`;

    const removeInterceptor = installApprovalRejectionInterceptor(this.deps.agentClient, {
      toolName,
      expectedCallId,
      rejectionMessage,
    });

    const approve = getMethod<[unknown], void>(abortedContext.state, 'approve');
    approve?.call(abortedContext.state, abortedContext.interruption);

    return { abortedContext, removeInterceptor };
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
    const interruptionRecord = asRecord(interruption);

    let toolStartedEvent: ConversationEvent | undefined;

    if (answer === 'y') {
      this.deps.logger.info('Tool approval granted', {
        eventType: 'approval.granted',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });

      const { toolName, rawArguments } = getToolInfoFromInterruption(interruption);
      const callId = getCallIdFromObject(interruption);

      toolStartedEvent = {
        type: 'tool_started',
        toolCallId: callId ?? String(Date.now()),
        toolName,
        arguments: rawArguments,
      };

      const approve = getMethod<[unknown], void>(state, 'approve');
      approve?.call(state, interruption);
    } else {
      const toolName = getString(interruptionRecord, 'name') ?? 'unknown';
      const expectedCallId = getCallIdFromObject(interruption);
      const rejectionMessage = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';

      const installedInterceptor = tryInstallApprovalRejectionInterceptor(this.deps.agentClient, {
        toolName,
        expectedCallId,
        rejectionMessage,
      });

      if (installedInterceptor) {
        const approve = getMethod<[unknown], void>(state, 'approve');
        approve?.call(state, interruption);
        this.deps.approvalState.setPendingRemoveInterceptor(installedInterceptor);
      } else {
        const reject = getMethod<[unknown], void>(state, 'reject');
        reject?.call(state, interruption);
      }

      this.deps.logger.info('Tool approval rejected', {
        eventType: 'approval.rejected',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });
    }

    const removeInterceptor = this.deps.approvalState.getPending()?.removeInterceptor ?? noop;

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
