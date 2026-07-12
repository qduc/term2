import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import { collectTerminalResult } from '../session/terminal-result-collector.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import type { SessionRuntime, SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { SessionManager } from '../session/session-manager.js';
import type { AskUserAnswerSink, SubagentEventSinkHost } from '../conversation-agent-client.js';
import {
  QueueController,
  type ActionId,
  type ActiveExecution,
  type ExecutionId,
  type QueuePersistence,
  type QueueTurnDriver,
} from '../queue/queue-controller.js';

export type SendMessageOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  hallucinationRetryCount?: number;
  bypassInputSurgeGuard?: boolean;
  replayFromHistory?: boolean;
};

export type HandleApprovalDecisionOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  approvalAnswer?: string;
};

export type TurnFlow = Pick<SessionRuntime['turns'], 'start' | 'continueAfterApproval'> & {
  abort?: () => void;
};

type QueuedMessage = {
  readonly input: string | UserTurn;
  readonly options: SendMessageOptions;
  readonly resolve: (terminal: ConversationTerminal) => void;
  readonly reject: (error: unknown) => void;
};

type QueuedMessageSnapshot = { readonly requestId: string; readonly recovered?: boolean };

export type QueueStateKind =
  | 'idle'
  | 'running'
  | 'awaiting_active_action'
  | 'cancelling'
  | 'completing'
  | 'paused'
  | 'awaiting_preflight';

export interface QueueStateSnapshot {
  readonly queueLength: number;
  readonly stateKind: QueueStateKind;
  readonly pauseReason?: 'failure' | 'manual' | 'recovered_interrupted';
}

export type QueueStateObserver = (snapshot: QueueStateSnapshot) => void;

export type ConversationEventSink = (event: ConversationEvent) => void;

/**
 * Fired by the adapter when the queue has actually started executing a queued
 * message (i.e. after the in-flight turn finished and the next head is popped).
 * The receiver can use this to surface the message in the UI (e.g. append it
 * to the message list at the correct timeline position).
 *
 * `requestId` is the internal id assigned by the adapter in sendMessage().
 * `input` is the original turn so callers can render the full content,
 * including images and skill attachments.
 */
export type QueuedTurnStartObserver = (execution: {
  readonly requestId: string;
  readonly input: string | UserTurn;
}) => void;

export class ConversationAdapter {
  #sessionId: string;
  #startedAt: string;
  #eventSink: ConversationEventSink | null = null;
  #askUserAnswerSink: AskUserAnswerSink | null;
  #subagentEventSinkHost: SubagentEventSinkHost | null;
  #logger: ILoggingService;
  #settingsService?: ISettingsService;
  #sessionContextService: ISessionContextService;
  #userTurns: Pick<SessionManager, 'listUserTurns'>;
  #logs: SessionLogs;
  #approval: SessionApprovalQuery;
  #turnFlow: TurnFlow;
  readonly #pendingMessages: Array<{
    readonly requestId: string;
    readonly message: QueuedMessage;
  }> = [];
  readonly #messagesById = new Map<string, QueuedMessage>();
  readonly #queue: QueueController<QueuedMessageSnapshot, ConversationTerminal> | null;
  #nextQueuedMessageId = 1;
  #nextActionId = 1;
  #activeTurn: Promise<void> = Promise.resolve();
  #cancellation: Promise<void> = Promise.resolve();
  #approvalExecutionId: ExecutionId | null = null;
  #approvalActionId: ActionId | null = null;
  #queueStateObserver: QueueStateObserver | null = null;
  #queuedTurnStartObserver: QueuedTurnStartObserver | null = null;

  constructor(deps: {
    sessionId: string;
    startedAt: string;
    askUserAnswerSink?: AskUserAnswerSink | null;
    subagentEventSinkHost?: SubagentEventSinkHost | null;
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
    userTurns: Pick<SessionManager, 'listUserTurns'>;
    logs: SessionLogs;
    approval: SessionApprovalQuery;
    turnFlow: TurnFlow;
    queueForeground?: boolean;
    queuePersistence?: QueuePersistence<QueuedMessageSnapshot>;
  }) {
    this.#sessionId = deps.sessionId;
    this.#startedAt = deps.startedAt;
    this.#askUserAnswerSink = deps.askUserAnswerSink ?? null;
    this.#subagentEventSinkHost = deps.subagentEventSinkHost ?? null;
    this.#logger = deps.logger;
    this.#settingsService = deps.settingsService;
    this.#sessionContextService = deps.sessionContextService;
    this.#userTurns = deps.userTurns;
    this.#logs = deps.logs;
    this.#approval = deps.approval;
    this.#turnFlow = deps.turnFlow;
    if (deps.queueForeground) {
      const driver: QueueTurnDriver<QueuedMessageSnapshot> = {
        start: (execution) => this.#startQueuedTurn(execution),
        cancel: async () => {
          await this.#activeTurn;
        },
      };
      this.#queue = new QueueController({
        driver,
        snapshotFactory: (item) => {
          if (Date.parse(item.submittedAt) < Date.parse(this.#startedAt)) {
            return { requestId: `recovered:${item.id}`, recovered: true };
          }
          const pending = this.#pendingMessages.shift();
          return pending ? { requestId: pending.requestId } : { requestId: `recovered:${item.id}`, recovered: true };
        },
        persistence: deps.queuePersistence,
      });
    } else {
      this.#queue = null;
    }
  }

  setEventSink(sink: ConversationEventSink | null): void {
    this.#eventSink = sink;
  }

  setQueueStateObserver(observer: QueueStateObserver | null): void {
    this.#queueStateObserver = observer;
    // Immediately notify with current state
    this.#notifyQueueState();
  }

  setQueuedTurnStartObserver(observer: QueuedTurnStartObserver | null): void {
    this.#queuedTurnStartObserver = observer;
  }

  isQueueActive(): boolean {
    if (!this.#queue) {
      // Without a queue, the adapter is a pass-through. Treat the adapter as
      // active only while the run-as-foreground path is in flight.
      return false;
    }
    const state = this.#queue.state();
    return (
      state.kind === 'running' ||
      state.kind === 'awaiting_active_action' ||
      state.kind === 'cancelling' ||
      state.kind === 'completing'
    );
  }

  #notifyQueueState(): void {
    if (!this.#queue || !this.#queueStateObserver) return;
    const state = this.#queue.state();
    this.#queueStateObserver({
      queueLength: state.queue.length,
      stateKind: state.kind,
      pauseReason: 'reason' in state ? (state as any).reason : undefined,
    });
  }

  #getTrafficMode(): string {
    if (!this.#settingsService) return 'standard';
    if (this.#settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.#settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.#settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.#settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #withTrafficContext<T>(currentTurn: string | undefined, fn: () => T): T {
    const mode = this.#getTrafficMode();
    const turns = this.#userTurns.listUserTurns();
    const firstTurn = turns[0]?.text ?? currentTurn;
    const firstUserMessagePreview = firstTurn ? firstTurn.slice(0, 160).replace(/\n/g, ' ') : undefined;

    return this.#sessionContextService.runWithContext(
      {
        sessionId: this.#sessionId,
        sessionStartedAt: this.#startedAt,
        mode,
        traceId: this.#logger.getCorrelationId(),
        firstUserMessagePreview,
      },
      fn,
    );
  }

  async sendMessage(
    input: string | UserTurn,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
      bypassInputSurgeGuard,
      replayFromHistory,
    }: SendMessageOptions = {},
  ): Promise<ConversationTerminal> {
    const queue = this.#queue;
    if (!queue) {
      return this.#executeMessage(input, {
        onTextChunk,
        onReasoningChunk,
        onCommandMessage,
        onEvent,
        hallucinationRetryCount,
        bypassInputSurgeGuard,
        replayFromHistory,
      });
    }
    return new Promise<ConversationTerminal>((resolve, reject) => {
      const requestId = String(this.#nextQueuedMessageId++);
      const message = {
        input,
        options: {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent,
          hallucinationRetryCount,
          bypassInputSurgeGuard,
          replayFromHistory,
        },
        resolve,
        reject,
      };
      this.#messagesById.set(requestId, message);
      this.#pendingMessages.push({ requestId, message });
      void queue
        .command({ kind: 'submit', text: normalizeUserTurn(input).text || '\u0000queued-message' })
        .then(() => this.#notifyQueueState());
    });
  }

  async resumeQueue(): Promise<void> {
    if (!this.#queue) return;
    await this.#cancellation;
    await this.#queue.command({ kind: 'resume_queue' });
    this.#notifyQueueState();
  }

  async discardQueue(): Promise<void> {
    if (!this.#queue) return;
    await this.#queue.command({ kind: 'discard_queue' });
    this.#notifyQueueState();
  }

  /**
   * Remove the last (most recently queued) item from the queue and return its
   * text so the caller can move it back to the input box. Returns null when
   * the queue is empty, the adapter has no queue (pass-through mode), or the
   * underlying controller rejects the removal.
   *
   * Also pops the matching pending message from the internal pending list so
   * the queue/pending state observers fire consistently.
   */
  async removeLastQueuedItem(): Promise<{ text: string } | null> {
    const queue = this.#queue;
    if (!queue) return null;

    const state = queue.state();
    if (state.queue.length === 0) return null;

    // The queue is FIFO. The "last" queued item is the one at the tail.
    const lastItem = state.queue[state.queue.length - 1]!;

    const result = await queue.command({ kind: 'remove_queued', itemId: lastItem.id });
    if (result.kind !== 'accepted') return null;

    // The pending message list is in submission order. The corresponding
    // pending entry for this item is the last one we added. Removing it keeps
    // the adapter's internal bookkeeping consistent with the queue controller.
    this.#pendingMessages.pop();
    // Note: we don't need to touch #messagesById here because the queue head
    // has not yet started executing this item (it was still queued), so there
    // is no pending execution for it to resolve. The pending message entry
    // was only there to support the snapshot factory if the head was popped.

    this.#notifyQueueState();
    return { text: lastItem.text };
  }

  abort(): void {
    if (!this.#queue) {
      this.#turnFlow.abort?.();
      return;
    }
    this.#turnFlow.abort?.();
    this.#cancellation = this.#queue.command({ kind: 'cancel' }).then(() => {
      this.#notifyQueueState();
    });
  }

  #startQueuedTurn(execution: ActiveExecution<QueuedMessageSnapshot>): void {
    // Notify the orchestrator/UI before kicking off the run so that the user
    // message can be appended to the message list with the correct timeline.
    const message = this.#messagesById.get(execution.snapshot.requestId);
    if (message && this.#queuedTurnStartObserver) {
      try {
        this.#queuedTurnStartObserver({
          requestId: execution.snapshot.requestId,
          input: message.input,
        });
      } catch (error) {
        this.#logger.error('queuedTurnStartObserver threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#activeTurn = this.#runQueuedTurn(execution);
  }

  async #runQueuedTurn(execution: ActiveExecution<QueuedMessageSnapshot>): Promise<void> {
    const message = this.#messagesById.get(execution.snapshot.requestId);
    if (message) this.#messagesById.delete(execution.snapshot.requestId);
    try {
      const result = await this.#executeMessage(message?.input ?? execution.item.text, message?.options ?? {});
      if (result.type === 'approval_required') {
        this.#approvalExecutionId = execution.executionId;
        this.#approvalActionId = `adapter-action-${this.#nextActionId++}` as ActionId;
        await this.#queue!.event({
          kind: 'tool_approval_requested',
          executionId: execution.executionId,
          actionId: this.#approvalActionId,
          request: {}, // existing runtime doesn't expose typed tool request details
        });
        this.#notifyQueueState();
        message?.resolve(result);
        return;
      }
      await this.#queue!.event({ kind: 'completed', executionId: execution.executionId, terminal: result });
      this.#notifyQueueState();
      message?.resolve(result);
    } catch (error) {
      await this.#queue!.event({ kind: 'failed', executionId: execution.executionId, failure: error });
      this.#notifyQueueState();
      message?.reject(error);
    }
  }

  async #executeMessage(
    input: string | UserTurn,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
      bypassInputSurgeGuard,
      replayFromHistory,
    }: SendMessageOptions = {},
  ): Promise<ConversationTerminal> {
    const turn = normalizeUserTurn(input);
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#logs.dispatchEventToLog(event);
        this.#eventSink?.(event);
        onEvent?.(event);
      };
      this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
      let result: ConversationTerminal;
      try {
        const startOptions: any = { retries: { hallucinationRetryCount } };
        if (bypassInputSurgeGuard !== undefined) {
          startOptions.bypassInputSurgeGuard = bypassInputSurgeGuard;
        }
        if (replayFromHistory) {
          startOptions.replayFromHistory = true;
        }
        result = await collectTerminalResult(this.#turnFlow.start(input, startOptions), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.#approval.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.#logger.debug('sendMessage received final event', {
              sessionId: this.#sessionId,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        this.#subagentEventSinkHost?.setSubagentEventSink(null);
      }

      if (result.type === 'response') {
        this.#logger.debug('sendMessage returning response', {
          sessionId: this.#sessionId,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, approvalAnswer }: HandleApprovalDecisionOptions = {},
  ): Promise<ConversationTerminal | null> {
    if (!this.#approval.getPending()) {
      return null;
    }

    if (answer === 'y' && approvalAnswer) {
      const pending = this.#approval.getPending();
      const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
      if (callId) {
        this.#askUserAnswerSink?.setAskUserAnswer(callId, approvalAnswer);
      }
    }

    this.#logs.log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    try {
      // If queue tracks this approval, resolve the typed action before continuing.
      if (this.#queue && this.#approvalExecutionId && this.#approvalActionId) {
        const actionCmd = await this.#queue.command({
          kind: 'resolve_tool_approval',
          executionId: this.#approvalExecutionId,
          actionId: this.#approvalActionId,
          approved: answer === 'y',
        });
        this.#notifyQueueState();
        // If the queue rejected (e.g. stale from concurrent cancel), proceed
        // with the direct continuation but do not attempt further queue events.
        if (actionCmd.kind !== 'accepted') {
          this.#approvalExecutionId = null;
          this.#approvalActionId = null;
        }
      }

      const result = await this.#withTrafficContext(undefined, async () => {
        const wrappedOnEvent = (event: ConversationEvent) => {
          this.#logs.dispatchEventToLog(event);
          this.#eventSink?.(event);
          onEvent?.(event);
        };
        this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
        let result: ConversationTerminal | null;
        try {
          result = await collectTerminalResult(this.#turnFlow.continueAfterApproval({ answer, rejectionReason }), {
            onTextChunk,
            onReasoningChunk,
            onCommandMessage,
            onEvent: wrappedOnEvent,
            getRawInterruption: () => this.#approval.getPendingInterruption(),
            onFinalEvent: (event) => {
              this.#logger.debug('handleApprovalDecision received final event', {
                sessionId: this.#sessionId,
                hasUsage: Boolean(event.usage),
                usage: event.usage,
              });
            },
          });
        } finally {
          this.#subagentEventSinkHost?.setSubagentEventSink(null);
        }

        if (result && result.type === 'response') {
          this.#logger.debug('handleApprovalDecision returning response', {
            sessionId: this.#sessionId,
            hasUsage: Boolean(result.usage),
            usage: result.usage,
          });
        }

        return result;
      });
      if (result && this.#queue && this.#approvalExecutionId) {
        const executionId = this.#approvalExecutionId;
        this.#approvalExecutionId = null;
        this.#approvalActionId = null;
        await this.#queue.event({ kind: 'completed', executionId, terminal: result });
        this.#notifyQueueState();
      }
      return result;
    } catch (error) {
      if (this.#queue && this.#approvalExecutionId) {
        const executionId = this.#approvalExecutionId;
        this.#approvalExecutionId = null;
        this.#approvalActionId = null;
        await this.#queue.event({ kind: 'failed', executionId, failure: error });
        this.#notifyQueueState();
      }
      throw error;
    }
  }
}
