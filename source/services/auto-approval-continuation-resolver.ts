import type { AgentStream } from './agent-stream.js';
import type { ApprovalContinuationRunner } from './approval-continuation-runner.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import { buildConversationResult } from './conversation-result-builder.js';
import type { ILoggingService } from './service-interfaces.js';
import type { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { CommandMessage } from '../tools/types.js';
import type { ConversationTerminal } from '../contracts/conversation.js';
import type { NormalizedUsage } from '../utils/token-usage.js';

/**
 * Resolves auto-approval continuations. When a tool call is auto-approved,
 * this class manages the continuation loop, accumulating usage, text, and
 * turn items from the follow-up stream.
 */
export class AutoApprovalContinuationResolver {
  readonly #approvalFlow: ApprovalFlowCoordinator;
  readonly #getShellAutoApproval: () => ShellAutoApprovalResolver;
  readonly #logger: ILoggingService;
  readonly #sessionId: string;
  readonly #toolTracker: SessionToolTracker;
  readonly #turnAccumulator: TurnItemAccumulator;
  readonly #continuationRunner: ApprovalContinuationRunner;
  readonly #retryOrchestrator: SessionRetryOrchestrator;

  constructor(deps: {
    approvalFlow: ApprovalFlowCoordinator;
    shellAutoApproval: ShellAutoApprovalResolver | (() => ShellAutoApprovalResolver);
    logger: ILoggingService;
    sessionId: string;
    toolTracker: SessionToolTracker;
    turnAccumulator: TurnItemAccumulator;
    continuationRunner: ApprovalContinuationRunner;
    retryOrchestrator: SessionRetryOrchestrator;
  }) {
    this.#approvalFlow = deps.approvalFlow;
    this.#getShellAutoApproval =
      typeof deps.shellAutoApproval === 'function'
        ? (deps.shellAutoApproval as () => ShellAutoApprovalResolver)
        : () => deps.shellAutoApproval as ShellAutoApprovalResolver;
    this.#logger = deps.logger;
    this.#sessionId = deps.sessionId;
    this.#toolTracker = deps.toolTracker;
    this.#turnAccumulator = deps.turnAccumulator;
    this.#continuationRunner = deps.continuationRunner;
    this.#retryOrchestrator = deps.retryOrchestrator;
  }

  async *buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationTerminal, void> {
    const outcome = await buildConversationResult(
      {
        result,
        finalOutputOverride,
        reasoningOutputOverride,
        emittedCommandIds,
        usage,
        toolCallArgumentsById: this.#toolTracker.argumentsById,
        turnItems: this.#turnAccumulator.getTurnItems(),
      },
      {
        approvalFlow: this.#approvalFlow,
        shellAutoApproval: this.#getShellAutoApproval(),
        logger: this.#logger,
        sessionId: this.#sessionId,
      },
    );

    if (outcome.kind !== 'auto_approve') {
      return outcome.result;
    }

    let finalText = '';
    let reasoningText = '';
    let finalUsage: NormalizedUsage | undefined;
    let continuationApprovalUsage: NormalizedUsage | undefined;
    const commandMessages: CommandMessage[] = [];
    let approvalRequiredResult: ConversationTerminal | undefined;
    let continuationTurnItems: PersistedAssistantTurnItem[] | undefined;

    for await (const event of this.#continuationRunner.continueAfterApproval({
      answer: 'y',
      generation: this.#retryOrchestrator.currentGeneration,
    })) {
      if (event.type === 'approval_required') {
        continuationApprovalUsage = event.usage;
        // The continuation resumes the same live RunState, so its usage
        // accumulator is already cumulative for the whole run (it includes the
        // first, auto-approved turn). Prefer it directly; only fall back to the
        // first turn's usage if the continuation didn't report any.
        const mergedUsage = continuationApprovalUsage ?? usage;
        const usagePatch = mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {};

        // collectTerminalResult returns on the first approval_required event, so
        // attach the run-cumulative usage onto the event itself.
        yield { ...event, ...usagePatch };

        approvalRequiredResult = {
          type: 'approval_required',
          approval: {
            ...event.approval,
            rawInterruption: this.#approvalFlow.getPendingInterruption(),
          },
          ...usagePatch,
        };
      } else if (event.type === 'final') {
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        finalUsage = event.usage;
        if (event.commandMessages) {
          commandMessages.push(...event.commandMessages);
        }
        if (event.turnItems) {
          continuationTurnItems = event.turnItems;
        }
      } else {
        yield event;
      }
    }

    if (approvalRequiredResult) {
      return approvalRequiredResult;
    }

    // finalUsage comes from the continuation, which reused the same live
    // RunState and therefore already accumulated the first (auto-approved)
    // turn. Prefer it; fall back to the first turn's usage only when the
    // continuation produced none.
    const combinedUsage = finalUsage ?? usage;
    return {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(combinedUsage && Object.keys(combinedUsage).length > 0 ? { usage: combinedUsage } : {}),
      turnItems: continuationTurnItems ?? this.#turnAccumulator.getTurnItems(),
    };
  }
}
