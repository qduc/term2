import { describeError, isAbortLikeError } from '../../utils/error-helpers.js';
import { createMessageIdFactory } from '../../utils/message-id-factory.js';
import type { ConversationOrchestratorConfig } from './conversation-orchestrator.types.js';
import type { ConversationEvent } from './conversation-events.js';
import type { SubmissionMutation } from './conversation-adapter.js';
import type { BotMessage, CommandMessage, UserMessage } from '../../types/message.js';
import { isCommandMessage, isUserMessage } from '../../types/message.js';
import type { ConversationTerminal, PendingApproval } from '../../contracts/conversation.js';
import { CHECK_IN_TOOL_NAME, isDeniedReadApproveAnswer } from '../../contracts/conversation.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { SessionCostSummary } from '../cost/model-cost.js';
import { createStreamingSession } from '../../utils/streaming/streaming-session-factory.js';
import type { StreamingState } from '../../utils/conversation/conversation-utils.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../../utils/conversation/conversation-utils.js';
import { clearStreamingBotMessage, computeNextMessages } from '../../utils/conversation/apply-conversation-result.js';
import { trimTrailingAssistantMessages } from '../../utils/conversation/message-utils.js';
import type { RewindTargetId } from './conversation-store.js';
import { ASK_USER_NO_ANSWER_RESULT } from '../../tools/agent/ask-user-constants.js';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
} from '../approval/approval-presentation-policy.js';
import {
  formatUserTurnForDisplay,
  hasUserTurnContent,
  injectSkillIntoTurn,
  normalizeUserTurn,
  type UserTurn,
} from '../../types/user-turn.js';
import type {
  BackgroundNotification,
  BackgroundSubagentNotification,
  BackgroundSubagentNotificationPort,
} from '../subagents/subagent-notification-store.js';
import type { RunBudgetEvent } from '../agent-runtime/run-budget.js';
import type { InputSurgeApproval } from '../input-surge-approval.js';
import type { RestoredState } from './conversation-replay.js';
import { formatBackgroundTaskLiveness } from '../background-task-activity.js';

const REASONING_RESPONSE_THROTTLE_MS = 200;

function formatRunBudgetEvidence(event: RunBudgetEvent): string {
  if (event.type === 'tool_stall') {
    return `Repeated tool call: ${event.toolName} (${event.count}/${event.threshold})\narguments: ${event.argumentsText}`;
  }
  const { evidence } = event;
  return `${event.stage} budget stage: ${evidence.dimension}; used ${evidence.used}/${evidence.limit}; headroom ${evidence.headroom}`;
}

/**
 * Render settled background runs as one instruction to the main agent. Previews
 * are already capped by the notification store, so the full output is offered
 * by reference rather than inlined.
 */
function formatBackgroundSubagentNotifications(notifications: readonly BackgroundNotification[]): string {
  const completions = notifications.filter(
    (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'completion' }> =>
      notification.kind === 'completion',
  );
  const questions = notifications.filter(
    (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'question' }> =>
      notification.kind === 'question',
  );
  const budgets = notifications.filter(
    (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'budget' }> =>
      notification.kind === 'budget',
  );
  const shellCompletions = notifications.filter(
    (notification): notification is Extract<BackgroundNotification, { kind: 'shell_completion' }> =>
      notification.kind === 'shell_completion',
  );
  const shellOutputs = notifications.filter(
    (notification): notification is Extract<BackgroundNotification, { kind: 'shell_output' }> =>
      notification.kind === 'shell_output',
  );
  const userControls = notifications.filter(
    (notification): notification is Extract<BackgroundNotification, { kind: 'user_control' }> =>
      notification.kind === 'user_control',
  );
  const checkIns = notifications.filter(
    (notification): notification is Extract<BackgroundNotification, { kind: 'check_in' }> =>
      notification.kind === 'check_in',
  );
  const sections: string[] = [];

  if (completions.length > 0) {
    const noun = completions.length === 1 ? 'run' : 'runs';
    const entries = completions.map((notification) => {
      const lines = [
        `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        '  result:',
        notification.formattedResult
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      ];
      return lines.join('\n');
    });
    sections.push(
      [
        `Background subagent ${noun} finished (${completions.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'The full result is inlined above; you do not need to call get_subagent_result. Assess it against the task before you accept it, then continue through the next necessary steps yourself rather than stopping at the fact that a run finished. Tell the user concisely, in your own words, what you concluded — the report is input to your judgement, not a message to relay.',
      ].join('\n'),
    );
  }

  if (questions.length > 0) {
    const entries = questions.map((notification) => {
      const target = notification.name ?? notification.runId;
      return [
        `- messageId: ${notification.messageId} | target: ${target} | runId: ${notification.runId} | role: ${notification.role}`,
        `  question: ${notification.question}`,
      ].join('\n');
    });
    sections.push(
      [
        `Background subagent question${questions.length === 1 ? '' : 's'} pending (${
          questions.length
        }). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Decide the answer, investigate it yourself, or escalate to the user if needed. To answer a specific waiting subagent, call send_message({ target, reply_to: messageId, message }). The subagent has no direct user channel; an answer resumes only its waiting tool call.',
      ].join('\n'),
    );
  }

  if (budgets.length > 0) {
    const entries = budgets.map((notification) => {
      const target = notification.name ?? notification.runId;
      return `- target: ${target} | runId: ${notification.runId} | role: ${
        notification.role
      }\n  ${formatRunBudgetEvidence(notification.event)}`;
    });
    sections.push(
      [
        `Background subagent budget/stall evidence (${budgets.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        // Do not offer continue-with-extension: no child-targeted grant API
        // exists, so the run keeps going inside its own envelope regardless.
        // Promising an action the parent cannot take produces confident,
        // ineffective replies and teaches it to ignore this lane.
        'Judge the evidence and act only if the run is going wrong: steer it with specific corrective guidance via send_message({ target, message }), or stop it with the background task controls. Doing nothing is a valid judgement — the run continues within its own budget and, at critical, ends itself with a summary of what it completed.',
      ].join('\n'),
    );
  }

  if (shellCompletions.length > 0) {
    const noun = shellCompletions.length === 1 ? 'job' : 'jobs';
    const entries = shellCompletions.map((notification) =>
      [
        `- jobId: ${notification.jobId} | command: ${notification.command} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        '  output:',
        notification.output
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      ].join('\n'),
    );
    sections.push(
      [
        `Background shell ${noun} finished (${shellCompletions.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Assess the command result against the task and continue through the next necessary steps. Tell the user concisely, in your own words, what you concluded.',
      ].join('\n'),
    );
  }

  if (shellOutputs.length > 0) {
    const noun = shellOutputs.length === 1 ? 'watch' : 'watches';
    const entries = shellOutputs.map((notification) =>
      [
        `- jobId: ${notification.jobId} | command: ${notification.command} | watchId: ${notification.watchId} | seq: ${notification.seq}`,
        ...(notification.droppedBytes !== undefined ? [`  droppedBytes: ${notification.droppedBytes}`] : []),
        '  matchedLines:',
        notification.matchedLines
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      ].join('\n'),
    );
    sections.push(
      [
        `Background shell ${noun} matched output (${shellOutputs.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Assess whether the matched output changes what you should do next and continue through the next necessary steps yourself, telling the user concisely, in your own words, what you concluded.',
      ].join('\n'),
    );
  }

  if (checkIns.length > 0) {
    const noun = checkIns.length === 1 ? 'task' : 'tasks';
    const entries = checkIns.map((notification) => {
      const { details } = notification;
      const elapsedSeconds = Math.round(notification.elapsedMs / 1000);
      if (details.kind === 'subagent') {
        const nameLabel = details.name ? `${details.name} (${details.id})` : details.id;
        const header = `- background subagent ${nameLabel} | role: ${details.role} | task: ${details.task}`;
        const lines = [header];

        const activityParts: string[] = [];
        if (details.activityState) {
          if (details.activityState === 'waiting' && details.waitingReason) {
            activityParts.push(`waiting (${details.waitingReason})`);
          } else {
            activityParts.push(details.activityState);
          }
        }
        const activityDesc = activityParts.length > 0 ? `status: ${activityParts.join(', ')} | ` : '';
        lines.push(
          `  ${activityDesc}still running, elapsed ${elapsedSeconds}s, check-in #${notification.checkInIndex}`,
        );
        if (details.activity) lines.push(`  liveness: ${formatBackgroundTaskLiveness(details.activity)}`);

        if (details.latestNarrative) {
          lines.push(`  latest narrative: "${details.latestNarrative}"`);
        }

        if (details.toolCounts && Object.keys(details.toolCounts).length > 0) {
          const countsStr = Object.entries(details.toolCounts)
            .map(([tool, count]) => `${tool} (${count})`)
            .join(', ');
          lines.push(`  tools used: ${countsStr}`);
        }

        if (details.lastToolName) {
          lines.push(`  last tool: ${details.lastToolName}`);
        } else if (details.lastObservation?.kind === 'tool_started') {
          lines.push(`  last tool: ${details.lastObservation.toolName} [running]`);
        }

        return lines.join('\n');
      }

      const header = `- background shell | jobId: ${details.id} | command: ${details.command}`;
      const lines = [header];
      const statusDesc = details.status ? `status: ${details.status} | ` : '';
      lines.push(`  ${statusDesc}still running, elapsed ${elapsedSeconds}s, check-in #${notification.checkInIndex}`);
      if (details.activity) lines.push(`  liveness: ${formatBackgroundTaskLiveness(details.activity)}`);

      if (details.outputTail) {
        lines.push('  recent output:');
        const tailLines = details.outputTail.split('\n').map((line) => `    ${line}`);
        lines.push(...tailLines);
      }

      return lines.join('\n');
    });
    sections.push(
      [
        `Periodic check-in on ${checkIns.length} still-running background ${noun}. This is an automatic system notification, not a user message, and does not by itself mean anything is wrong.`,
        '',
        ...entries,
        '',
        'Decide freely: doing nothing and letting it keep running is a valid choice. Only report to the user or intervene (steer or stop the task) if the elapsed time or task nature makes that the right call.',
      ].join('\n'),
    );
  }

  if (userControls.length > 0) {
    const stopControls = userControls.filter((notification) => notification.action === 'stop');
    const backgroundMoves = userControls.filter((notification) => notification.action === 'background');
    const entriesFor = (notifications: typeof userControls, verb: string) =>
      notifications.map((notification) => {
        const details = notification.details;
        return details.kind === 'subagent'
          ? `- ${verb} background subagent ${details.name ?? details.id} | runId: ${details.id} | role: ${
              details.role
            } | task: ${details.task}`
          : `- ${verb} background shell | jobId: ${details.id} | command: ${details.command}`;
      });
    if (stopControls.length > 0) {
      sections.push(
        [
          `The user requested that ${
            stopControls.length === 1 ? 'a background task be stopped' : 'background tasks be stopped'
          }. This is an automatic user control notification, not a user message.`,
          '',
          ...entriesFor(stopControls, 'stop requested for'),
          '',
          'Plan the next step around the requested stop. The task may settle later with a cancelled completion notification; do not assume its result is available yet.',
        ].join('\n'),
      );
    }
    if (backgroundMoves.length > 0) {
      const movedSubagents = backgroundMoves.filter((notification) => notification.details.kind === 'subagent').length;
      const movedShells = backgroundMoves.length - movedSubagents;
      const movedWhat =
        movedSubagents > 0 && movedShells === 0
          ? movedSubagents === 1
            ? 'a foreground subagent into the background'
            : 'foreground subagents into the background'
          : movedShells > 0 && movedSubagents === 0
          ? movedShells === 1
            ? 'a foreground shell into the background'
            : 'foreground shells into the background'
          : 'foreground work into the background';
      sections.push(
        [
          `The user moved ${movedWhat}. This is an automatic user control notification, not a user message.`,
          '',
          ...entriesFor(backgroundMoves, 'moved to'),
          '',
          'The same execution continues running in the background. Plan the next step without waiting for it, and do not stop or relaunch it unless the task now requires that.',
        ].join('\n'),
      );
    }
  }

  return sections.join('\n\n');
}

/** The user-facing companion to the model-only background notification instruction. */
function formatBackgroundSubagentNotificationDisplay(notifications: readonly BackgroundNotification[]): string {
  return notifications
    .map((notification) => {
      if (notification.kind === 'question') {
        const target = notification.name ?? notification.runId;
        return [
          `messageId: ${notification.messageId} | target: ${target} | runId: ${notification.runId} | role: ${notification.role}`,
          `question: ${notification.question}`,
        ].join('\n');
      }
      if (notification.kind === 'budget') {
        return [
          `- runId: ${notification.runId} | role: ${notification.role}`,
          `  ${formatRunBudgetEvidence(notification.event)}`,
        ].join('\n');
      }
      if (notification.kind === 'shell_completion') {
        return [
          `- jobId: ${notification.jobId} | command: ${notification.command} | status: ${notification.status}`,
          ...(notification.error ? [`  error: ${notification.error}`] : []),
          ...(notification.output ? [`  output: ${notification.output}`] : []),
        ].join('\n');
      }
      if (notification.kind === 'shell_output') {
        return [
          `- jobId: ${notification.jobId} | command: ${notification.command} | watchId: ${notification.watchId} | seq: ${notification.seq}`,
          ...(notification.droppedBytes !== undefined ? [`  droppedBytes: ${notification.droppedBytes}`] : []),
          ...(notification.matchedLines ? [`  matchedLines: ${notification.matchedLines}`] : []),
        ].join('\n');
      }
      if (notification.kind === 'check_in') {
        const { details } = notification;
        const elapsedSeconds = Math.round(notification.elapsedMs / 1000);
        const label =
          details.kind === 'subagent'
            ? `background subagent ${details.name ?? details.id} (${details.role})`
            : `background shell ${details.command}`;
        return `Check-in #${notification.checkInIndex}: ${label} still running, elapsed ${elapsedSeconds}s`;
      }
      if (notification.kind === 'user_control') {
        const details = notification.details;
        if (notification.action === 'background') {
          return details.kind === 'subagent'
            ? `Moved to background: ${details.name ?? details.id} (${details.role})`
            : `Moved to background: shell ${details.command}`;
        }
        return details.kind === 'subagent'
          ? `Stop requested: background ${details.name ?? details.id} (${details.role})`
          : `Stop requested: shell ${details.command}`;
      }
      const lines = [
        `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        ...(notification.preview ? [`  preview: ${notification.preview}`] : []),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

export class ConversationOrchestrator {
  private readonly createMessageId: () => string;
  readonly #directlyAppendedMessageIds = new Set<string>();
  readonly #displayedBackgroundNotificationMessageIds = new Set<string>();
  /**
   * Deferred queue submissions register an activator here. The orchestrator does
   * not count them as active turns until the queue actually starts executing
   * them — remove/discard/reject must not require a matching `#endTurn`.
   */
  readonly #deferredTurnActivators = new Map<string, () => void>();
  /**
   * A pending steer retracted through the id-addressed mutation path. The
   * adapter intentionally keeps the shared steer API boolean, so this marker
   * distinguishes a deliberate retraction from an ordinary failed steer.
   */
  readonly #retractedSteerIds = new Set<string>();
  /** Latest user turn for a pending steer edited before admission. */
  readonly #editedSteerTurns = new Map<string, UserTurn>();
  /**
   * Turns this orchestrator currently owns. Count only executions that have
   * actually started (direct submit or queue-start activation), never merely
   * queued awaits.
   */
  #activeTurns = 0;
  /** True while {@link stopProcessing} is tearing the conversation down. */
  #stoppingByUser = false;
  /** Stranded rows already reported, so the warning stays one per occurrence. */
  readonly #reportedStrandedCallIds = new Set<string>();

  constructor(private config: ConversationOrchestratorConfig) {
    this.createMessageId = config.createMessageId ?? createMessageIdFactory(config.now);
    // Wire queue state observer from the adapter through to the UI.
    if (typeof config.conversationService.setQueueStateObserver === 'function') {
      config.conversationService.setQueueStateObserver((snapshot) => {
        config.ui.onQueueStateChange(snapshot);
      });
    }
    // When the queue has actually popped the next head and is about to start
    // its turn, the orchestrator appends the user message to the message list
    // (with the timeline the turn actually started at) and clears the pending
    // indicator above the input box.
    if (typeof config.conversationService.setQueuedTurnStartObserver === 'function') {
      config.conversationService.setQueuedTurnStartObserver((execution) => {
        if (execution.suppressUserMessageDisplay) {
          // Still retire any matching pending row. A suppressed start is a
          // real delivery; leaving the queued indicator would lie.
          this.config.ui.onQueuedMessageStarted?.(execution.requestId);
          return;
        }
        // Deferred submissions activate their orchestrator turn here — the only
        // moment a queued await becomes an owned execution.
        const activateDeferred = this.#deferredTurnActivators.get(execution.requestId);
        if (activateDeferred) {
          activateDeferred();
        }
        const wasAlreadyStarted = this.moveQueuedMessageIntoList(execution.requestId, execution.input);
        if (!wasAlreadyStarted && !activateDeferred) {
          // Recovered or test-only starts without a deferred activator still need
          // the processing indicator when the message enters the transcript.
          config.ui.onTurnStart();
        }
      });
    }
    // A background subagent run can settle at any time, including while the
    // conversation is idle and nothing would otherwise wake the agent.
    if (typeof config.conversationService.setBackgroundSubagentNotificationObserver === 'function') {
      config.conversationService.setBackgroundSubagentNotificationObserver(() => {
        void this.#deliverBackgroundSubagentNotifications();
      });
    }
  }

  updateCallbacks({
    onRestoreInput,
    onClear,
  }: Pick<ConversationOrchestratorConfig, 'onRestoreInput' | 'onClear'>): void {
    this.config.onRestoreInput = onRestoreInput;
    this.config.onClear = onClear;
  }

  getSubagentUsage(): NormalizedUsage | null {
    return this.config.subagentUsageAccumulator?.get() ?? null;
  }

  getCostSummary(): SessionCostSummary | null {
    return this.config.costAccumulator?.getSummary() ?? null;
  }

  goToPreviousQuestion(): void {
    this.config.conversationService.goToPreviousPendingInteractionQuestion?.();
  }

  goToNextQuestion(): void {
    this.config.conversationService.goToNextPendingInteractionQuestion?.();
  }

  async clearConversation(): Promise<void> {
    if (this.config.onClear) {
      await this.config.onClear();
    } else {
      this.config.conversationService.resetWithNewId(crypto.randomUUID());
    }

    this.config.messages.setMessages(() => []);
    this.config.approvedContext.current = null;
    this.config.conversationService.clearPendingInteraction?.();
    this.config.ui.onResetAll();
    this.config.usageAccumulator?.reset();
    this.config.subagentUsageAccumulator?.reset();
    this.config.costAccumulator?.reset();
    this.#directlyAppendedMessageIds.clear();
    this.#displayedBackgroundNotificationMessageIds.clear();
    this.#retractedSteerIds.clear();
    this.#editedSteerTurns.clear();
    this.#reportedStrandedCallIds.clear();
  }

  /**
   * Replace the live UI projection with a persisted conversation after the
   * caller has moved the service to the restored session id.
   */
  restoreConversation(
    restored: Pick<RestoredState, 'messages' | 'history' | 'previousResponseId' | 'toolLedger' | 'updatedAt'> & {
      usage?: RestoredState['usage'];
      subagentUsage?: RestoredState['subagentUsage'];
      costRecords?: RestoredState['costRecords'];
    },
  ): void {
    this.config.conversationService.importState({
      history: restored.history,
      previousResponseId: restored.previousResponseId,
      toolLedger: restored.toolLedger,
      updatedAt: restored.updatedAt,
    });
    this.config.messages.setMessages(() => [...restored.messages]);
    this.config.approvedContext.current = null;
    this.config.conversationService.clearPendingInteraction?.();
    this.config.ui.onResetAll();
    this.config.usageAccumulator?.reset();
    this.config.subagentUsageAccumulator?.reset();
    this.config.costAccumulator?.reset();
    if (restored.usage) {
      this.config.usageAccumulator?.add(restored.usage, { alreadyBillable: true });
      this.config.ui.onUsageUpdate(restored.usage);
    }
    if (restored.subagentUsage) {
      this.config.subagentUsageAccumulator?.add(restored.subagentUsage, { alreadyBillable: true });
    }
    if (restored.costRecords?.length) {
      const costAccumulator = this.config.costAccumulator;
      costAccumulator?.addRecords(restored.costRecords);
      if (costAccumulator) this.config.ui.onCostUpdate?.(costAccumulator.getSummary());
    }
    this.#directlyAppendedMessageIds.clear();
    this.#displayedBackgroundNotificationMessageIds.clear();
    this.#retractedSteerIds.clear();
    this.#editedSteerTurns.clear();
    this.#reportedStrandedCallIds.clear();
  }

  stopProcessing(): void {
    // The user asked everything to stop, so background subagent runs go too.
    // Undo and retry, by contrast, only abort the turn.
    //
    // Cancelling those runs makes each of them emit its own completion event,
    // so the notification queue must be suppressed and then dropped: the user
    // already knows the runs stopped, and waking the agent to say so is the
    // opposite of what they asked for.
    this.#stoppingByUser = true;
    try {
      this.config.conversationService.interruptFromUser();
      this.config.messages.setMessages((messages) =>
        messages.map((message) =>
          message.sender === 'command' && (message.status === 'running' || message.status === 'pending')
            ? { ...message, status: 'aborted' as const }
            : message,
        ),
      );
      this.config.approvedContext.current = null;
      this.config.conversationService.clearPendingInteraction?.();
      this.config.ui.onResetTransient();
      this.#directlyAppendedMessageIds.clear();
      this.#displayedBackgroundNotificationMessageIds.clear();
      this.#retractedSteerIds.clear();
      this.#editedSteerTurns.clear();
      this.config.conversationService.backgroundSubagentNotifications?.drain();
    } finally {
      this.#stoppingByUser = false;
    }
  }

  /**
   * Rewind through an opaque store target. `uiIndex` is used only to trim the
   * rendered projection after the domain operation accepted the same target.
   */
  rewindToTarget(targetId: RewindTargetId, uiIndex: number): { text: string; images?: UserTurn['images'] } | null {
    const restored = this.config.conversationService.rewindToTarget(targetId);
    if (restored === null) return null;

    // Keep rewind's historical foreground-only cancellation behavior, but do
    // not abort an active turn for a stale picker target that the store rejects.
    this.config.conversationService.abort();
    this.config.messages.setMessages((prev) => prev.slice(0, uiIndex));
    this.config.approvedContext.current = null;
    this.config.conversationService.clearPendingInteraction?.();
    this.config.ui.onResetTransient();
    this.#directlyAppendedMessageIds.clear();
    this.#displayedBackgroundNotificationMessageIds.clear();

    return restored;
  }

  async retractPendingSubmission(id: string): Promise<SubmissionMutation> {
    const service = this.config.conversationService;
    if (typeof service.retractSubmission !== 'function') return { kind: 'unknown_id' };

    const result = await service.retractSubmission(id);
    if (result.kind === 'applied') {
      if (result.stage === 'pending_steer') {
        this.#retractedSteerIds.add(id);
        this.#editedSteerTurns.delete(id);
      }
      this.config.ui.onQueuedMessageRemoved?.(id);
    }
    return result;
  }

  async editPendingSubmission(id: string, turn: UserTurn): Promise<SubmissionMutation> {
    const service = this.config.conversationService;
    if (typeof service.editSubmission !== 'function') return { kind: 'unknown_id' };

    const result = await service.editSubmission(id, turn);
    if (result.kind === 'applied') {
      if (result.stage === 'pending_steer') {
        this.#editedSteerTurns.set(id, structuredClone(normalizeUserTurn(turn)));
      }
      this.config.ui.onQueuedMessageEdited?.(id, formatUserTurnForDisplay(normalizeUserTurn(turn)));
    }
    return result;
  }

  async retryLastToolOutput(): Promise<boolean> {
    this.config.conversationService.abort();
    this.config.approvedContext.current = null;
    this.config.conversationService.clearPendingInteraction?.();
    this.config.ui.onResetTransient();

    if (!this.config.conversationService.peekLastToolOutput()) {
      return false;
    }

    this.config.messages.setMessages((prev) => trimTrailingAssistantMessages(prev));

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('retryLastToolOutput');

    try {
      const result = await this.config.conversationService.retryLastToolOutput({
        onEvent: this.createOnEventHandler(applyConversationEvent),
      });

      if (!result) {
        return false;
      }

      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
      return true;
    } catch (error) {
      this.logError('Error in retryLastToolOutput', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in retryLastToolOutput');
        return true;
      }

      const errorMessage = enhanceApiKeyError(describeError(error));
      this.appendBotError(errorMessage);
      return true;
    } finally {
      this.config.loggingService.debug('retryLastToolOutput finally block - resetting state');
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.#endTurn();
    }
  }

  /** Start a fresh, user-authorized retry from canonical transcript state. */
  async retryLastFailedTurn(): Promise<boolean> {
    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('retryLastFailedTurn');
    try {
      const result = await this.config.conversationService.retryLastFailedTurn({
        onEvent: this.createOnEventHandler(applyConversationEvent),
        replayFromHistory: true,
      });
      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
      return result !== null;
    } catch (error) {
      this.logError('Error in retryLastFailedTurn', error);
      if (!isAbortLikeError(error)) this.appendBotError(enhanceApiKeyError(describeError(error)));
      return false;
    } finally {
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.#endTurn();
    }
  }

  async compactContext(): Promise<string> {
    this.#activeTurns += 1;
    this.config.ui.onTurnStart();
    try {
      return await this.config.conversationService.compactContext();
    } finally {
      this.#endTurn();
    }
  }

  async sendUserMessage(
    input: string | UserTurn,
    options?: {
      inputSurgeApproval?: InputSurgeApproval;
      busyMode?: 'steer' | 'follow_up';
      presentation?: UserMessage['presentation'];
    },
  ): Promise<void> {
    const turn = normalizeUserTurn(input);
    if (!hasUserTurnContent(turn)) {
      return;
    }

    const userMessage: UserMessage = {
      id: this.createMessageId(),
      sender: 'user',
      text: formatUserTurnForDisplay(turn),
      ...(turn.skill ? { skill: turn.skill } : {}),
      ...(options?.presentation ? { presentation: options.presentation } : {}),
    };

    // When no turn is in flight, append the user message directly to the
    // message list. The queue observer will still fire when the turn starts,
    // but the dedup guard in moveQueuedMessageIntoList will swallow the
    // second append. When a turn is already in flight, show the message
    // above the input box until the queue actually starts processing it; the
    // message list will be updated when the queue pops this turn.
    const queueOwnsSubmission =
      this.config.conversationService.isQueueOwningSubmissions?.() ??
      this.config.conversationService.isQueueActive?.() ??
      false;

    // Logged before the branch below, not inside it. "Steer attempt resolved"
    // only exists on the path that actually tries to steer, so a submission
    // that never enters that path — because it arrived without busyMode
    // 'steer', or because the queue did not claim it — is indistinguishable in
    // the logs from one that was never submitted at all. That gap hid a real
    // report of a steer silently queueing: the queue file held the message and
    // the transcript held the user_message, and nothing recorded the decision
    // in between. These four fields name that decision.
    this.config.loggingService.info('Submission routing decided', {
      busyMode: options?.busyMode ?? 'none',
      queueOwnsSubmission,
      queueStateKind: this.config.conversationService.queueStateKind?.() ?? 'unknown',
      canSteer: Boolean(this.config.conversationService.steerActiveTurn),
      messageId: userMessage.id,
    });

    if (queueOwnsSubmission) {
      const delivery: 'steer' | 'follow_up' = options?.busyMode === 'steer' ? 'steer' : 'follow_up';

      // A steer belongs to the turn already running: hand it to that turn so
      // the model reads it at its next request, rather than making the user
      // wait for the whole turn to end. The message joins the transcript at the
      // moment the turn takes it, which is when the model actually sees it.
      if (delivery === 'steer' && this.config.conversationService.steerActiveTurn) {
        // Show "Steering" while the active turn may still be waiting for its
        // next request boundary. A follow-up (Alt+Enter) is the only case that
        // should read as "Queued" here.
        this.config.ui.onQueuedMessagePending?.(userMessage.id, userMessage.text, delivery);
        // Diagnostics for "my steer just queued". The three fields below
        // separate the ways delivery can fail, which otherwise look identical
        // in the UI because the queued label is drawn before this even runs:
        //   queueActive=false            → refused by the adapter's predicate;
        //     the queue owns the submission but is not in a state that offers
        //     steering (awaiting_preflight, paused, idle with retained work).
        //   queueActive=true, waited≈0ms → refused synchronously downstream:
        //     awaiting an approval, or no run in flight at the run loop.
        //   queueActive=true, waited>0ms → held as pending and released when
        //     the run ended: the turn never reached another request boundary.
        //   steered=true                 → admitted; waitedMs is how long the
        //     user waited for the turn to reach that boundary.
        const queueActive = this.config.conversationService.isQueueActive?.() ?? false;
        const queueStateKind = this.config.conversationService.queueStateKind?.() ?? 'unknown';
        const steerStartedAt = Date.now();
        const steered = await this.config.conversationService
          .steerActiveTurn(turn, { id: userMessage.id })
          .catch((error) => {
            this.logError('Error steering the active turn', error);
            return false;
          });
        this.config.loggingService.info('Steer attempt resolved', {
          steered,
          queueActive,
          queueStateKind,
          waitedMs: Date.now() - steerStartedAt,
          messageId: userMessage.id,
        });
        if (steered) {
          const admittedTurn = this.#editedSteerTurns.get(userMessage.id) ?? turn;
          this.#editedSteerTurns.delete(userMessage.id);
          const { skill: _originalSkill, ...messageWithoutSkill } = userMessage;
          const admittedMessage: UserMessage = {
            ...messageWithoutSkill,
            text: formatUserTurnForDisplay(admittedTurn),
            ...(admittedTurn.skill ? { skill: admittedTurn.skill } : {}),
          };
          this.config.ui.onQueuedMessageStarted?.(userMessage.id);
          this.config.messages.appendMessages([admittedMessage]);
          this.config.logWriter?.append({ type: 'user_message', message: { ...admittedMessage } });
          return;
        }
        if (this.#retractedSteerIds.delete(userMessage.id)) {
          this.#editedSteerTurns.delete(userMessage.id);
          return;
        }
        this.#editedSteerTurns.delete(userMessage.id);
        this.config.ui.onQueuedMessageReclassified?.(userMessage.id, 'follow_up');
      } else {
        this.config.ui.onQueuedMessagePending?.(userMessage.id, userMessage.text, delivery);
      }
    } else {
      // No turn is in flight — append directly. The queue observer will also
      // fire when the turn starts, but the dedup guard in
      // moveQueuedMessageIntoList prevents a double-append.
      this.config.messages.appendMessages([userMessage]);
      this.#directlyAppendedMessageIds.add(userMessage.id);
    }
    this.config.logWriter?.append({ type: 'user_message', message: { ...userMessage } });

    // Streaming callbacks are bound at submit time, but deferred submissions
    // must not count as active turns until the queue starts them. Otherwise
    // remove/discard would need a matching endTurn for work that never ran.
    let turnActivated = !queueOwnsSubmission;
    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } = queueOwnsSubmission
      ? this.createTurnSession('sendUserMessage')
      : this.#beginTurn('sendUserMessage');

    if (queueOwnsSubmission) {
      this.#deferredTurnActivators.set(userMessage.id, () => {
        if (turnActivated) return;
        turnActivated = true;
        this.#activeTurns += 1;
        this.config.ui.onTurnStart();
      });
    }

    try {
      const turnToSend = turn.skill ? injectSkillIntoTurn(turn) : turn;
      const result = await this.config.conversationService.sendMessage(turnToSend, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        inputSurgeApproval: options?.inputSurgeApproval,
        busyMode: options?.busyMode,
        preferredMessageId: userMessage.id,
      });

      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error in sendUserMessage', error);

      if (queueOwnsSubmission) {
        this.config.ui.onQueuedMessageRemoved?.(userMessage.id);
      }

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in sendUserMessage');
        return;
      }

      // A submission that never left the pending queue produced no turn to
      // report on, but it also produced no answer: the pending indicator has
      // just been cleared, so saying nothing would make the user's text vanish
      // without explanation. Report the rejection and hand the text back.
      if (queueOwnsSubmission && !turnActivated) {
        this.appendBotError(
          `${enhanceApiKeyError(describeError(error))}\n\nThis message was not sent: ${userMessage.text}`,
        );
        return;
      }

      const rawErrorMessage = describeError(error);
      const errorMessage = enhanceApiKeyError(rawErrorMessage);
      const dropped = (error as any)?.rawEvent?.droppedUserMessage as { text: string; imageCount: number } | undefined;
      if (dropped) {
        this.config.messages.setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].sender === 'user') {
              return prev.slice(0, i);
            }
          }
          return prev;
        });
        this.config.onRestoreInput?.(dropped.text);
      }

      if (isMaxTurnsError(errorMessage)) {
        const pendingApproval: PendingApproval = {
          agentName: 'System',
          toolName: CHECK_IN_TOOL_NAME,
          argumentsText: errorMessage,
          rawInterruption: null,
          checkIn: 'max_turns',
        };
        this.config.conversationService.presentPendingInteraction?.(pendingApproval);
        this.config.ui.onApprovalRequested(pendingApproval);
      } else {
        this.appendBotError(errorMessage);
      }
    } finally {
      this.config.loggingService.debug('sendUserMessage finally block - resetting state');
      this.#deferredTurnActivators.delete(userMessage.id);
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      // The start observer is the normal way a queued row leaves the pending
      // list. If that callback is skipped — recovered snapshot, suppressed
      // display, or a test/service path that settles sendMessage without
      // starting — the submission has still left the queue. Drop the row
      // here so a delivered message cannot stay painted as queued.
      if (queueOwnsSubmission) {
        this.config.ui.onQueuedMessageStarted?.(userMessage.id);
      }
      if (turnActivated) {
        this.#endTurn();
      }
    }
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason: string | undefined,
    approvalAnswer: string | undefined,
    expectedInteractionId: number,
    options: { stopAfterApprovalResolution?: boolean } = {},
  ): Promise<void> {
    const resolution = this.config.conversationService.resolvePendingInteraction?.({
      expectedInteractionId,
      answer,
      rejectionReason,
      approvalAnswer,
    });
    if (!resolution || resolution.kind === 'none' || resolution.kind === 'stale_interaction') {
      return;
    }
    if (resolution.kind === 'awaiting_next_question') return;

    const pendingApproval = resolution.approval;
    const isMaxTurnsPrompt = pendingApproval.checkIn === 'max_turns';
    const runBudgetEvent = pendingApproval.runBudgetEvent;

    this.config.ui.onApprovalResolved();

    if (answer === 'y' || isDeniedReadApproveAnswer(answer)) {
      this.config.approvedContext.current = {
        callId: pendingApproval.callId,
        toolName: pendingApproval.toolName,
      };
    }

    if (isMaxTurnsPrompt && !runBudgetEvent && answer === 'n') {
      this.#endTurn();
      return;
    }

    if (isMaxTurnsPrompt && !runBudgetEvent && answer === 'y') {
      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        this.#beginTurn('maxTurnsContinuation');

      try {
        const result = await this.config.conversationService.sendMessage('Please continue with your previous task.', {
          onEvent: this.createOnEventHandler(applyConversationEvent),
        });

        applyConversationEvent({ type: 'final', finalText: '' });
        this.applyServiceResult(result, streamingState, streamingState.latestUsage);
      } catch (error) {
        this.logError('Error in continuation after max turns', error);

        if (isAbortLikeError(error)) {
          this.config.loggingService.debug('Suppressing abort error in max turns continuation');
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.appendBotError(errorMessage);
      } finally {
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        this.#endTurn();
      }

      return;
    }

    // Steer is part of the judge's vocabulary, but no human surface produces it
    // here: the prompt offers Continue and Stop only, and collecting corrective
    // text would need an input surface this prompt does not own. A human steers
    // by continuing and then typing. Parent agents steer with send_message.
    if (runBudgetEvent && answer === 'y') {
      // Take the grant here rather than leaving it to the resume, because a
      // refusal has to be shown to the human instead of silently stopping.
      const grant = this.config.conversationService.grantRunBudgetExtension?.() ?? {
        granted: false,
        extensionsGranted: 0,
      };
      if (!grant.granted) {
        this.#presentRunBudgetInteraction(runBudgetEvent, 'No further budget extension is available.');
        return;
      }
    }

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
      this.#beginTurn('approvalDecision');

    try {
      const result = await this.config.conversationService.handleApprovalDecision(answer, rejectionReason, {
        onEvent: this.createOnEventHandler(applyConversationEvent),
        approvalAnswer: resolution.approvalAnswer,
        ...(options.stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
      });
      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error in handleApprovalDecision', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in handleApprovalDecision');
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.appendBotError(errorMessage);
    } finally {
      this.config.loggingService.debug('handleApprovalDecision finally block - resetting state');
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      this.#endTurn();
    }
  }

  /**
   * Escape on an `ask_user` prompt. The tool still returns
   * {@link ASK_USER_NO_ANSWER_RESULT}, so the question and the fact that it
   * went unanswered are committed to history and travel with the user's next
   * message. The turn then ends instead of handing the model another turn:
   * cancelling means the user speaks next.
   */
  async cancelAskUser(expectedInteractionId: number): Promise<void> {
    return this.handleApprovalDecision('y', undefined, ASK_USER_NO_ANSWER_RESULT, expectedInteractionId, {
      stopAfterApprovalResolution: true,
    });
  }

  /** Open a turn this orchestrator owns, and its streaming session. */
  #beginTurn(label: string) {
    this.#activeTurns += 1;
    this.config.ui.onTurnStart();
    return this.createTurnSession(label);
  }

  /**
   * Close a turn this orchestrator owns. `flushNotifications` is false only for
   * the background-notification turn itself, which decides for itself whether
   * another delivery attempt is safe.
   */
  #endTurn(flushNotifications = true): void {
    this.#activeTurns = Math.max(0, this.#activeTurns - 1);
    this.config.ui.onTurnEnd();
    this.#finalizeStrandedCommandMessages();
    if (flushNotifications) {
      void this.#deliverBackgroundSubagentNotifications();
    }
  }

  /**
   * Close command rows that no completion will ever close.
   *
   * A row opens as `running` on `tool_started` and closes only when a command
   * message carrying the same callId arrives. Anything that ends a turn without
   * that message — a stream error, a retry, a tool whose result is never
   * rendered — leaves the row running for the rest of the session. That is not
   * cosmetic: a running command is the first message that cannot render
   * statically, so one stranded row keeps every later message re-rendering
   * outside Ink's Static region.
   *
   * The warning is half the point. A silent net would hide the next tool that
   * strands a row the way the last one hid for fourteen hours.
   */
  #finalizeStrandedCommandMessages(): void {
    // A turn that parks on an approval closes and reopens around the prompt, so
    // reaching here does not mean the work finished. Anything still running is
    // legitimately in flight until the user decides.
    if (this.#activeTurns > 0) return;
    if (this.config.conversationService.getPendingInteractionSnapshot?.()) return;

    const stranded = this.config.messages
      .getMessages()
      .filter(
        (message): message is CommandMessage =>
          isCommandMessage(message) && (message.status === 'running' || message.status === 'pending'),
      );
    if (stranded.length === 0) return;

    this.config.messages.setMessages((messages) =>
      messages.map((message) =>
        message.sender === 'command' && (message.status === 'running' || message.status === 'pending')
          ? { ...message, status: 'aborted' as const }
          : message,
      ),
    );

    const unreported = stranded.filter((message) => !this.#reportedStrandedCallIds.has(message.callId ?? message.id));
    if (unreported.length === 0) return;
    for (const message of unreported) {
      this.#reportedStrandedCallIds.add(message.callId ?? message.id);
    }
    this.config.loggingService.warn('Command rows left running at turn end; aborting them', {
      tools: unreported.map((message) => message.toolName ?? 'unknown'),
      callIds: unreported.map((message) => message.callId ?? message.id),
    });
  }

  /**
   * Announce settled runs in the transcript, once each.
   *
   * Display is deliberately not tied to the agent receiving them: the user
   * should see a run land the moment it does, whether the report reaches the
   * agent at the next request boundary or waits for a turn of its own.
   */
  #announceBackgroundSubagentNotifications(notifications: readonly BackgroundNotification[]): void {
    const newlyDisplayed = notifications.filter(
      (notification) => !this.#displayedBackgroundNotificationMessageIds.has(notification.messageId),
    );
    if (newlyDisplayed.length === 0) return;
    for (const notification of newlyDisplayed) {
      this.#displayedBackgroundNotificationMessageIds.add(notification.messageId);
    }
    const subagentNotifications = newlyDisplayed.filter(
      (notification): notification is BackgroundSubagentNotification =>
        notification.kind === 'completion' || notification.kind === 'question' || notification.kind === 'budget',
    );
    const runs = subagentNotifications
      .filter(
        (notification): notification is Extract<BackgroundSubagentNotification, { kind: 'completion' }> =>
          notification.kind === 'completion',
      )
      .map(({ name, role, status, error }) => ({
        ...(name !== undefined ? { name } : {}),
        role,
        status,
        ...(error ? { error } : {}),
      }));
    const shellJobs = newlyDisplayed.filter(
      (notification): notification is Extract<BackgroundNotification, { kind: 'shell_completion' }> =>
        notification.kind === 'shell_completion',
    );
    const shellOutputs = newlyDisplayed.filter(
      (notification): notification is Extract<BackgroundNotification, { kind: 'shell_output' }> =>
        notification.kind === 'shell_output',
    );
    const userControls = newlyDisplayed.filter(
      (notification): notification is Extract<BackgroundNotification, { kind: 'user_control' }> =>
        notification.kind === 'user_control',
    );
    const checkIns = newlyDisplayed.filter(
      (notification): notification is Extract<BackgroundNotification, { kind: 'check_in' }> =>
        notification.kind === 'check_in',
    );
    this.config.messages.appendMessages([
      ...(subagentNotifications.length > 0
        ? [
            {
              id: this.createMessageId(),
              sender: 'command' as const,
              status: 'completed' as const,
              command: 'background_subagent_notification',
              output: formatBackgroundSubagentNotificationDisplay(subagentNotifications),
              success: true,
              toolName: 'background_subagent_notification',
              toolArgs: { runs },
            },
          ]
        : []),
      ...(shellJobs.length > 0
        ? [
            {
              id: this.createMessageId(),
              sender: 'command' as const,
              status: 'completed' as const,
              command: 'background_shell_notification',
              output: formatBackgroundSubagentNotificationDisplay(shellJobs),
              success: true,
              toolName: 'background_shell_notification',
              toolArgs: {
                jobs: shellJobs.map(({ jobId, command, status, error }) => ({
                  jobId,
                  command,
                  status,
                  ...(error ? { error } : {}),
                })),
              },
            },
          ]
        : []),
      ...(shellOutputs.length > 0
        ? [
            {
              id: this.createMessageId(),
              sender: 'command' as const,
              status: 'completed' as const,
              command: 'background_shell_output_notification',
              output: formatBackgroundSubagentNotificationDisplay(shellOutputs),
              success: true,
              toolName: 'background_shell_output_notification',
              toolArgs: {
                firings: shellOutputs.map(
                  ({ jobId, command, watchId, seq, matchedLines, coalescedCount, seqRange, droppedBytes }) => ({
                    jobId,
                    command,
                    watchId,
                    seq,
                    matchedLines,
                    ...(coalescedCount !== undefined ? { coalescedCount } : {}),
                    ...(seqRange !== undefined ? { seqRange } : {}),
                    ...(droppedBytes !== undefined ? { droppedBytes } : {}),
                  }),
                ),
              },
            },
          ]
        : []),
      ...(userControls.length > 0
        ? [
            {
              id: this.createMessageId(),
              sender: 'command' as const,
              status: 'completed' as const,
              command: 'background_task_control_notification',
              output: formatBackgroundSubagentNotificationDisplay(userControls),
              success: true,
              toolName: 'background_task_control_notification',
              toolArgs: {
                actions: userControls.map(({ action, target }) => ({ action, target })),
              },
            },
          ]
        : []),
      ...(checkIns.length > 0
        ? [
            {
              id: this.createMessageId(),
              sender: 'command' as const,
              status: 'completed' as const,
              command: 'background_check_in_notification',
              output: formatBackgroundSubagentNotificationDisplay(checkIns),
              success: true,
              toolName: 'background_check_in_notification',
              toolArgs: {
                checkIns: checkIns.map(({ target, checkInIndex, elapsedMs }) => ({
                  target,
                  checkInIndex,
                  elapsedMs,
                })),
              },
            },
          ]
        : []),
    ]);
  }

  /**
   * Offer settled runs to the turn already in flight.
   *
   * Taken as one report at that turn's next request boundary. If the turn will
   * not take them they go back to the store unchanged, so the idle path still
   * delivers them and the agent never sees the same run twice.
   */
  async #injectBackgroundSubagentNotifications(pending: BackgroundSubagentNotificationPort): Promise<void> {
    if (!this.config.conversationService.injectIntoActiveTurn) return;
    const notifications = pending.drain();
    if (notifications.length === 0) return;

    this.#announceBackgroundSubagentNotifications(notifications);

    const injected = await this.config.conversationService
      .injectIntoActiveTurn([
        { type: 'message', role: 'user', content: formatBackgroundSubagentNotifications(notifications) },
      ])
      .catch((error) => {
        this.logError('Error delivering background subagent notifications', error);
        return false;
      });

    if (!injected) pending.retain(notifications);
  }

  /**
   * Hand every settled background subagent run to the main agent.
   *
   * The agent that launched these runs is usually still working when they
   * settle, so delivery goes into that turn at its next request boundary. Only
   * when no turn will take them does this open one of its own.
   */
  async #deliverBackgroundSubagentNotifications(): Promise<void> {
    const pending = this.config.conversationService.backgroundSubagentNotifications;
    if (!pending || pending.pendingCount === 0) return;
    if (this.#stoppingByUser) return;

    const turnIsRunning = this.#activeTurns > 0 || this.config.conversationService.isQueueActive?.() === true;
    if (turnIsRunning) {
      await this.#injectBackgroundSubagentNotifications(pending);
      return;
    }
    if (this.config.conversationService.getPendingInteractionSnapshot?.()) return;

    const notifications = pending.drain();
    if (notifications.length === 0) return;

    this.#announceBackgroundSubagentNotifications(notifications);

    const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } = this.#beginTurn(
      'backgroundSubagentNotification',
    );

    let delivered = false;
    try {
      const result = await this.config.conversationService.sendMessage(
        formatBackgroundSubagentNotifications(notifications),
        {
          onEvent: this.createOnEventHandler(applyConversationEvent),
          suppressUserMessageDisplay: true,
        },
      );

      // A turn the queue refused to admit resolves without a terminal, so the
      // notifications were never seen and must go back on the queue.
      delivered = Boolean(result);
      applyConversationEvent({ type: 'final', finalText: '' });
      botResponseUpdater.flush();
      this.applyServiceResult(result, streamingState, streamingState.latestUsage);
    } catch (error) {
      this.logError('Error delivering background subagent notifications', error);

      if (isAbortLikeError(error)) {
        this.config.loggingService.debug('Suppressing abort error in background subagent notification turn');
        return;
      }

      this.appendBotError(enhanceApiKeyError(describeError(error)));
    } finally {
      reasoningUpdater.flush();
      botResponseUpdater.cancel();
      if (!delivered) {
        pending.retain(notifications);
      }
      // Only a delivered batch may chain: retrying a failed batch immediately
      // would spin. Anything still queued waits for the next turn or completion.
      this.#endTurn(delivered);
    }
  }

  private createTurnSession(label: string) {
    return createStreamingSession(
      {
        appendMessages: this.config.messages.appendMessages,
        setMessages: this.config.messages.setMessages,
        trimMessages: this.config.messages.trimMessages,
        annotateCommandMessage: (msg) => this.annotateCommandMessage(msg),
        loggingService: this.config.loggingService,
        setLastUsage: (usage) => this.config.ui.onUsageUpdate(usage),
        setCodexRateLimit: (rateLimit) => this.config.ui.onRateLimitUpdate(rateLimit),
        setStreamingSpeed: (speed) => this.config.ui.onStreamingSpeedUpdate?.(speed),
        setRunBudgetNotice: (event) => this.config.ui.onRunBudgetNotice?.(event),
        reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
        now: this.config.now,
      },
      label,
    );
  }

  private createOnEventHandler(baseOnEvent: (event: ConversationEvent) => void): (event: ConversationEvent) => void {
    return (event: ConversationEvent) => {
      const eventType = event.type;
      if (eventType === 'reasoning_delta') {
        this.config.ui.onStreamingThinkingStarted((this.config.now ?? Date.now)());
      } else if (this.clearsThinkingIndicator(eventType)) {
        this.config.ui.onStreamingThinkingCleared();
      }

      if (eventType === 'tool_call_streaming_delta') {
        this.config.ui.onStreamingToolInfo({ toolName: event.toolName, argumentCharCount: event.argumentCharCount });
      } else if (eventType === 'tool_started' || eventType === 'text_delta' || eventType === 'final') {
        this.config.ui.onStreamingToolInfo(null);
      }

      if (eventType === 'user_message_consumed_for_abort') {
        this.config.messages.setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const msg = prev[i];
            if (isUserMessage(msg)) {
              if (msg.consumedForAbort) return prev;
              const next = prev.slice();
              next[i] = { ...msg, consumedForAbort: true };
              return next;
            }
          }
          return prev;
        });
        return;
      }

      baseOnEvent(event);
      if (eventType === 'cost_update') {
        // Per-request cost records arrive live during the run; the terminal
        // result re-delivers the same records and the accumulator dedups them
        // by request id, so adding here is idempotent.
        this.config.costAccumulator?.addRecord(event.record);
        this.emitCostSummary();
        return;
      }
      if (eventType === 'subagent_completed') {
        if (event.result.usage) {
          this.config.subagentUsageAccumulator?.add(event.result.usage);
        }
        this.config.costAccumulator?.addRecords(event.result.costRecords ?? []);
        this.emitCostSummary();
        if (!this.hasActiveBackgroundWork()) {
          this.config.notifier?.turnComplete();
        }
      }
      if (eventType === 'background_shell_completed') {
        if (!this.hasActiveBackgroundWork()) {
          this.config.notifier?.turnComplete();
        }
      }
    };
  }

  private hasActiveBackgroundWork(): boolean {
    const details = this.config.conversationService?.backgroundTaskControl?.listDetails?.() ?? [];
    for (const d of details) {
      if (d.kind === 'subagent') {
        if (
          d.status === 'running' ||
          d.status === 'awaiting_approval' ||
          d.status === 'waiting_for_answer' ||
          d.status === 'cancelling'
        ) {
          return true;
        }
      } else if (d.kind === 'shell') {
        if (d.status === 'running' || d.status === 'cancelling') {
          return true;
        }
      }
    }
    const approvals = this.config.conversationService?.backgroundSubagentApprovals?.getSnapshot?.();
    if (approvals && approvals.pendingCount > 0) return true;
    return false;
  }

  /** Push the accumulator's current summary to the UI after any cost add. */
  private emitCostSummary(): void {
    const summary = this.config.costAccumulator?.getSummary();
    if (summary) this.config.ui.onCostUpdate?.(summary);
  }

  private applyServiceResult(
    result: ConversationTerminal | null,
    streamingState: StreamingState,
    latestStreamedUsage?: NormalizedUsage | null,
  ): void {
    if (!result) {
      return;
    }

    if (result.type === 'approval_required') {
      if (result.usage) {
        this.config.ui.onUsageUpdate(latestStreamedUsage ?? result.usage);
      }

      this.config.messages.setMessages((prev) =>
        this.config.messages.trimMessages(filterPendingCommandMessagesForApproval(prev, result.approval)),
      );
      this.config.ui.onApprovalRequested({ ...result.approval, llmAdvisory: result.approval.llmAdvisory });
      this.config.notifier?.approvalNeeded();
      return;
    }

    this.config.messages.setMessages(
      (prev) =>
        computeNextMessages({
          prev,
          result,
          streamingState,
          createMessageId: this.createMessageId,
          trimMessages: this.config.messages.trimMessages,
          annotateCommandMessage: (msg) => this.annotateCommandMessage(msg),
        }).next,
    );
    if (result.type === 'response' && streamingState.currentBotMessageId !== null) {
      clearStreamingBotMessage(streamingState);
    }
    this.config.ui.onApprovalResolved();
    if (!this.hasActiveBackgroundWork()) {
      this.config.notifier?.turnComplete();
    }
    if (result.usage) {
      this.config.usageAccumulator?.add(result.usage);
      this.config.ui.onUsageUpdate(latestStreamedUsage ?? result.usage);
    }
    this.config.costAccumulator?.addRecords(result.costRecords ?? []);
    this.emitCostSummary();
  }

  /**
   * Append a previously-queued user message into the message list. Called by
   * the queue when it actually starts processing the next turn. After the
   * append, the pending indicator above the input box is cleared.
   */
  private moveQueuedMessageIntoList(messageId: string, fallbackInput?: string | UserTurn): boolean {
    // If the message was already appended directly (when no turn was in flight),
    // the queue observer fired after the fact — skip the duplicate append and
    // avoid restarting its UI lifecycle. Still emit message-started so stale
    // pending UI state cannot survive a queue-state race.
    const wasAlreadyStarted = this.#directlyAppendedMessageIds.has(messageId);
    if (wasAlreadyStarted) {
      this.#directlyAppendedMessageIds.delete(messageId);
    }

    // The message id we created up-front matches the one we will append now.
    // We do not look it up by id because by the time the queue fires the
    // observer the original UserMessage may not be reachable, so we re-build
    // a minimal one with the same id and the formatted text.
    let resolved: UserMessage | null = null;

    if (fallbackInput !== undefined) {
      const turn = normalizeUserTurn(fallbackInput);
      if (hasUserTurnContent(turn)) {
        resolved = {
          id: messageId,
          sender: 'user',
          text: formatUserTurnForDisplay(turn),
          ...(turn.skill ? { skill: turn.skill } : {}),
        };
      }
    }

    if (resolved && !wasAlreadyStarted) {
      this.config.messages.appendMessages([resolved]);
    }

    this.config.ui.onQueuedMessageStarted?.(messageId);
    return wasAlreadyStarted;
  }

  private annotateCommandMessage(cmdMsg: CommandMessage): CommandMessage {
    const approvedMessage = annotateApprovedCommandMessage(cmdMsg, this.config.approvedContext.current);
    const matchedByToolName =
      approvedMessage !== cmdMsg &&
      !this.config.approvedContext.current?.callId &&
      Boolean(this.config.approvedContext.current?.toolName) &&
      this.config.approvedContext.current?.toolName === cmdMsg.toolName;

    if (matchedByToolName) {
      this.config.approvedContext.current = null;
    }

    return approvedMessage;
  }

  private clearsThinkingIndicator(eventType: string): boolean {
    return (
      eventType === 'text_delta' ||
      eventType === 'tool_started' ||
      eventType === 'tool_call_streaming_delta' ||
      eventType === 'final'
    );
  }

  /** Reuse the established pending-approval surface for human budget judgement. */
  #presentRunBudgetInteraction(event: RunBudgetEvent, prefix?: string): void {
    if (this.config.conversationService.getPendingInteractionSnapshot?.()) return;
    const approval: PendingApproval = {
      agentName: 'System',
      toolName: CHECK_IN_TOOL_NAME,
      argumentsText: `${prefix ? `${prefix}\n\n` : ''}${formatRunBudgetEvidence(event)}`,
      rawInterruption: null,
      checkIn: 'run_budget',
      runBudgetEvent: event,
    };
    this.config.conversationService.presentPendingInteraction?.(approval);
    this.config.ui.onApprovalRequested(approval);
    this.config.notifier?.approvalNeeded();
  }

  private appendBotError(errorMessage: string): void {
    const botErrorMessage: BotMessage = {
      id: this.createMessageId(),
      sender: 'bot',
      status: 'finalized',
      text: `Error: ${errorMessage}`,
    };
    this.config.messages.appendMessages([botErrorMessage]);
  }

  private logError(message: string, error: unknown): void {
    // Abort-like failures are expected control flow for user cancellation and
    // must not be emitted as application errors. Keep this at the logging
    // boundary so every orchestrator call site shares the same classification.
    if (isAbortLikeError(error)) return;

    this.config.loggingService.error(message, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...(error instanceof Error && (error as any).eventKind ? { eventKind: (error as any).eventKind } : {}),
    });
  }
}
