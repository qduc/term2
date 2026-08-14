import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import { ApprovalDecisionExecutor } from './approval-decision-executor.js';
import {
  BackgroundSubagentApprovalQueue,
  type BackgroundSubagentApprovalDecision,
  type BackgroundSubagentApprovalResolutionRequest,
  type BackgroundSubagentApprovalSnapshot,
} from './background-subagent-approval-queue.js';
import type { PendingApprovalContext } from './approval-state.js';
import type { BackgroundSubagentApprovalPause } from '../subagents/foreground-subagent-lease.js';
import type { ToolOwnershipRegistry } from './tool-ownership-registry.js';

/**
 * Session-owned policy/control boundary for approvals paused by adopted child
 * leases. Root ApprovalState is deliberately not involved: its continuation
 * belongs to the foreground turn, while this controller only touches the
 * continuation retained by the matching lease.
 */
export class BackgroundSubagentApprovalController {
  readonly #queue = new BackgroundSubagentApprovalQueue();
  readonly #executor: ApprovalDecisionExecutor;
  readonly #toolOwnership: ToolOwnershipRegistry;

  constructor({
    logger,
    sessionId,
    toolOwnership,
    nestedCompatibility,
  }: {
    logger: ILoggingService;
    sessionId: string;
    toolOwnership: ToolOwnershipRegistry;
    nestedCompatibility?: NestedToolCompatibilityState;
  }) {
    this.#toolOwnership = toolOwnership;
    this.#executor = new ApprovalDecisionExecutor({ logger, sessionId, toolOwnership, nestedCompatibility });
  }

  getSnapshot(): BackgroundSubagentApprovalSnapshot {
    return this.#queue.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    return this.#queue.subscribe(listener);
  }

  close(): readonly unknown[] {
    return this.#queue.close();
  }

  resolve(request: BackgroundSubagentApprovalResolutionRequest) {
    return this.#queue.resolve(request);
  }

  /** Sink installed on the subagent runtime for pauses after a successful move. */
  publish = (pause: BackgroundSubagentApprovalPause): void => {
    const { toolName, rawArguments } = getToolInfoFromInterruption(pause.interruption);
    const toolCallId = getCallIdFromObject(pause.interruption) ?? `${pause.runId}:${pause.generation}`;
    const entry = {
      runId: pause.runId,
      generation: pause.generation,
      toolCallId,
      toolName,
      argumentsText: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? null),
    };
    this.#queue.enqueue(entry, {
      onResolve: (_entry, decision) =>
        pause.apply((application) => this.#apply(application, pause.role, decision))
          ? { kind: 'applied' as const }
          : { kind: 'rejected' as const },
      onRelease: () => {
        // Queue closure/removal is terminal for this arbitration path. It must
        // not leave attribution for a pause the session no longer presents.
        this.#toolOwnership.release(toolCallId);
      },
    });
  };

  #apply(
    application: Parameters<BackgroundSubagentApprovalPause['apply']>[0] extends (value: infer T) => boolean
      ? T
      : never,
    role: string,
    decision: BackgroundSubagentApprovalDecision,
  ): boolean {
    const pending: PendingApprovalContext = {
      state: application.handle,
      interruption: application.interruption,
      emittedCommandIds: new Set(),
      toolCallArgumentsById: new Map(),
      owner: { kind: 'subagent', agentId: application.runId, role },
    };
    this.#executor.resolve({
      pendingApprovalContext: pending,
      answer: decision.answer,
      rejectionReason: decision.rejectionReason,
    });
    return true;
  }
}
