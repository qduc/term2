import { getMethod } from '../interruption-info.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';

export class SessionContinuityReset {
  readonly #providerContinuity: ProviderContinuity;
  readonly #approvalFlow: ApprovalFlowCoordinator;
  readonly #toolTracker: SessionToolTracker;
  readonly #shellAutoApproval: ShellAutoApprovalResolver;
  readonly #inputPlanner: SessionInputPlanner;
  readonly #turnAccumulator: TurnItemAccumulator;
  readonly #agentClient: ConversationAgentClient;

  constructor(deps: {
    providerContinuity: ProviderContinuity;
    approvalFlow: ApprovalFlowCoordinator;
    toolTracker: SessionToolTracker;
    shellAutoApproval: ShellAutoApprovalResolver;
    inputPlanner: SessionInputPlanner;
    turnAccumulator: TurnItemAccumulator;
    agentClient: ConversationAgentClient;
  }) {
    this.#providerContinuity = deps.providerContinuity;
    this.#approvalFlow = deps.approvalFlow;
    this.#toolTracker = deps.toolTracker;
    this.#shellAutoApproval = deps.shellAutoApproval;
    this.#inputPlanner = deps.inputPlanner;
    this.#turnAccumulator = deps.turnAccumulator;
    this.#agentClient = deps.agentClient;
  }

  reset({ clearConversations = true }: { clearConversations?: boolean } = {}): void {
    this.#providerContinuity.clear();
    this.#approvalFlow.clearPending();
    this.#approvalFlow.consumeAborted();
    this.#toolTracker.clearArguments();
    this.#toolTracker.clearEmittedToolStarted();
    this.#shellAutoApproval.clearCache();
    this.#inputPlanner.reset();
    this.#turnAccumulator.resetPersistedTurnState();

    if (clearConversations) {
      const clearConversationsFn = getMethod<[], void>(this.#agentClient, 'clearConversations');
      clearConversationsFn?.call(this.#agentClient);
    }
  }
}
