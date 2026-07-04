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
import { resolveToolOwner } from './tool-owner.js';
import {
  deniedReadStore,
  executionOverrideStore,
  getProjectAllowReadStore,
} from '../../utils/shell/sandbox/denied-read-stores.js';
import { isDeniedReadApproveAnswer } from '../../contracts/conversation.js';

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

export type ApprovalDecisionInput = {
  kind: 'approval_decision';
  answer: string;
  rejectionReason?: string;
  generation: number;
};

export class ApprovalFlowCoordinator {
  constructor(private readonly deps: ApprovalFlowCoordinatorDeps) {}

  buildApprovalDecision(answer: string, rejectionReason?: string): ApprovalDecisionInput {
    return {
      kind: 'approval_decision',
      answer,
      rejectionReason,
      generation: this.deps.approvalState.getPending()?.token ?? 0,
    };
  }

  abort(): { aborted: boolean; callId?: string } {
    this.deps.agentClient.abort();
    const pending = this.deps.approvalState.getPending();
    const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
    if (this.deps.approvalState.abortPending()) {
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

    abortedContext.state.reject(abortedContext.interruption as any, { message: rejectionMessage });
    abortedContext.decisionsByCallId ??= new Map();
    if (expectedCallId) {
      abortedContext.decisionsByCallId.set(expectedCallId, 'rejected');
    }

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
    const decisionCallId = getCallIdFromObject(interruption);
    pendingApprovalContext.decisionsByCallId ??= new Map();

    let toolStartedEvent: ConversationEvent | undefined;

    // Denied-read decision values require approval (SDK resumes) plus an execution override.
    const deniedReadDecision = isDeniedReadApproveAnswer(answer);
    // The 'deny' decision is treated as a rejection.
    const isApproved = answer === 'y' || deniedReadDecision;

    if (isApproved) {
      // For denied-read decisions, set the execution override before the SDK resumes.
      if (deniedReadDecision) {
        const { rawArguments } = getToolInfoFromInterruption(interruption);
        const parsedArgs = parseToolCallArguments(rawArguments, {
          callId: decisionCallId ?? String(Date.now()),
          toolName: 'shell',
          sessionId: this.deps.sessionId,
          traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
        });
        const shellCommand = (parsedArgs.arguments as { command?: string } | null)?.command;
        if (typeof shellCommand === 'string') {
          const stagedInfo = deniedReadStore.consumeStaged(shellCommand);
          if (stagedInfo) {
            if (answer === 'allow-once' || answer === 'allow-remember') {
              executionOverrideStore.set(shellCommand, {
                extraAllowRead: [stagedInfo.suggestedParent],
              });
              if (answer === 'allow-remember') {
                getProjectAllowReadStore(process.cwd()).append(stagedInfo.suggestedParent);
                this.deps.logger.security('Sandbox allowed-read path remembered for project', {
                  path: stagedInfo.suggestedParent,
                  deniedPath: stagedInfo.path,
                  sensitive: stagedInfo.sensitive,
                  sessionId: this.deps.sessionId,
                });
              }
            } else if (answer === 'unsandboxed-once') {
              executionOverrideStore.set(shellCommand, { forceUnsandboxed: true });
            }
          }
        }
      }

      this.deps.logger.debug('Tool approval granted', {
        eventType: 'approval.granted',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        ...(deniedReadDecision ? { deniedReadDecision: answer } : {}),
      });

      const { toolName, rawArguments } = getToolInfoFromInterruption(interruption);
      const callId = decisionCallId;

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
      if (callId) {
        pendingApprovalContext.decisionsByCallId.set(callId, 'approved');
      }
    } else {
      const expectedCallId = decisionCallId;
      const rejectionMessage = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';

      markToolCallAsApprovalRejection(expectedCallId);

      state.reject?.(interruption as any, { message: rejectionMessage });
      if (expectedCallId) {
        pendingApprovalContext.decisionsByCallId.set(expectedCallId, 'rejected');
      }

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

  retargetPendingInterruption(interruption: unknown): PendingApprovalContext | null {
    const pending = this.deps.approvalState.getPending();
    if (!pending) {
      return null;
    }

    this.deps.approvalState.setPending({
      ...pending,
      interruption,
      promptedCallId: getCallIdFromObject(interruption),
      owner: resolveToolOwner(pending.state, interruption, this.deps.logger),
    });
    return this.deps.approvalState.getPending();
  }
}
