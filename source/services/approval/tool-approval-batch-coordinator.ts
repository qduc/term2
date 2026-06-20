import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import { createApprovalRequiredTerminal } from '../conversation/conversation-result-builder.js';
import type { ApprovalDecisionPolicy } from './approval-decision-policy.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import type { ContinuationPlanApplier } from '../session/continuation-plan-applier.js';
import type { ContinuationState } from '../session/continuation-state.js';
import {
  asRecord,
  getCallIdFromObject,
  getMethod,
  getString,
  getToolInfoFromInterruption,
} from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import type { ILoggingService } from '../service-interfaces.js';
import { toolApprovalPolicyRegistry, type ToolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';

export type BatchStageResult =
  | { kind: 'ready' }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'stale' };

export interface ToolApprovalBatchCoordinatorDeps {
  approvalFlow: ApprovalFlowCoordinator;
  planApplier: ContinuationPlanApplier;
  shellAutoApproval: ShellAutoApprovalResolver;
  logger: ILoggingService;
  sessionId: string;
  policyRegistry?: ToolApprovalPolicyRegistry;
  isCurrent?: (token: number) => boolean;
}

export interface ToolApprovalBatchStageInput {
  state: ContinuationState;
  interruptions?: unknown[];
  policy: ApprovalDecisionPolicy;
  token: number;
}

export class ToolApprovalBatchCoordinator {
  readonly #policyRegistry: ToolApprovalPolicyRegistry;

  constructor(private readonly deps: ToolApprovalBatchCoordinatorDeps) {
    this.#policyRegistry = deps.policyRegistry ?? toolApprovalPolicyRegistry;
  }

  async *stageBatch(input: ToolApprovalBatchStageInput): AsyncGenerator<ConversationEvent, BatchStageResult, void> {
    if (this.deps.isCurrent && !this.deps.isCurrent(input.token)) {
      return { kind: 'stale' };
    }

    const pending = this.deps.approvalFlow.getPending();
    if (!pending) {
      return { kind: 'ready' };
    }

    const siblings = input.interruptions ?? this.#interruptionsFor(input.state, pending?.interruptions);
    if (!Array.isArray(siblings) || siblings.length === 0) {
      return { kind: 'ready' };
    }

    if (pending) {
      pending.interruptions ??= siblings;
      pending.decisionsByCallId ??= new Map();
    }

    const runContext = asRecord(asRecord(input.state.currentState)?._context);
    const isToolApproved = getMethod<[{ toolName: string; callId: string }], boolean | undefined>(
      runContext,
      'isToolApproved',
    );

    for (const interruption of siblings) {
      if (this.deps.isCurrent && !this.deps.isCurrent(input.token)) {
        return { kind: 'stale' };
      }

      const callId = getCallIdFromObject(interruption);
      const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);
      if (!callId) {
        continue;
      }

      const pendingNow = this.deps.approvalFlow.getPending();
      if (pendingNow?.decisionsByCallId?.has(callId)) {
        continue;
      }
      if (isToolApproved?.({ toolName, callId }) !== undefined) {
        pendingNow?.decisionsByCallId?.set(callId, 'approved');
        continue;
      }

      const parseResult = parseToolCallArguments(rawArguments, {
        callId,
        toolName,
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
      });

      const registryDecision = await this.#policyRegistry.evaluate({
        toolName,
        args: parseResult.arguments,
        context: runContext,
      });

      let decision: 'approve' | 'reject' | 'prompt';
      let llmAdvisory;
      if (registryDecision.kind === 'auto_approve') {
        decision = 'approve';
      } else {
        llmAdvisory =
          toolName === 'shell' || toolName === 'bash'
            ? await this.deps.shellAutoApproval.resolveAdvisoryForInterruption({
                interruption,
                siblings,
              })
            : undefined;
        decision = await input.policy.decide({ toolName, argumentsText, callId, llmAdvisory });
      }

      this.deps.approvalFlow.retargetPendingInterruption(interruption);
      const retargeted = this.deps.approvalFlow.getPending();
      if (retargeted) {
        retargeted.interruptions ??= siblings;
        retargeted.decisionsByCallId ??= new Map();
        retargeted.promptedCallId = callId;
      }

      if (decision === 'prompt') {
        this.deps.planApplier.recordPendingApproval({ toolName, argumentsText, callId, llmAdvisory });
        const agent = asRecord(asRecord(interruption)?.agent);
        return {
          kind: 'approval_required',
          terminal: createApprovalRequiredTerminal({
            agentName: getString(agent, 'name') ?? 'Agent',
            toolName,
            argumentsText,
            rawInterruption: interruption,
            callId,
            llmAdvisory,
            usage: input.state.cumulativeUsage,
          }),
        };
      }

      const nextPlan = this.deps.approvalFlow.prepareContinuation(decision === 'approve' ? 'y' : 'n', undefined);
      if (!nextPlan) {
        throw new Error('Parallel approval batch lost its pending approval context');
      }
      const decidedPending = nextPlan.pendingApprovalContext;
      decidedPending.interruptions ??= siblings;
      decidedPending.decisionsByCallId ??= new Map();
      decidedPending.decisionsByCallId.set(callId, decision === 'approve' ? 'approved' : 'rejected');
      yield* this.deps.planApplier.applyNextPlan(
        nextPlan,
        input.state,
        input.state.previouslyEmittedIds,
        decision === 'approve',
      );
    }

    return { kind: 'ready' };
  }

  #interruptionsFor(state: ContinuationState, fallback: unknown[] | undefined): unknown[] | undefined {
    const getInterruptions = getMethod<[], unknown>(state.currentState, 'getInterruptions');
    const interruptions = getInterruptions?.();
    return Array.isArray(interruptions) ? interruptions : fallback;
  }
}
