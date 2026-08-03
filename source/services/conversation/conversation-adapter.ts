import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal, PostExecuteApprovalToken } from '../../contracts/conversation.js';
import { collectTerminalResult } from '../session/terminal-result-collector.js';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
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
  preferredMessageId?: string;
  /** The turn is model input only and must not be projected as a user message in the UI. */
  suppressUserMessageDisplay?: boolean;
  /** A busy-input steer supersedes the active foreground turn. */
  busyMode?: 'steer' | 'follow_up';
};

export type HandleApprovalDecisionOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  approvalAnswer?: string;
};

export type TurnFlow = Pick<SessionRuntime['turns'], 'start' | 'continueAfterApproval'> & {
  continueAfterPostExecuteApproval?: SessionRuntime['turns']['continueAfterPostExecuteApproval'];
  abort?: () => void;
  stopAfterCurrentTool?: () => void;
};

type QueuedMessage = {
  readonly input: string | UserTurn;
  readonly options: SendMessageOptions;
  readonly resolve: (terminal: ConversationTerminal) => void;
  readonly reject: (error: unknown) => void;
};

type QueuedMessageSnapshot = { readonly requestId: string; readonly recovered?: boolean };

const QUEUED_NON_TEXT_PLACEHOLDER = '[queued non-text user turn]';
const LEGACY_QUEUED_MESSAGE_PLACEHOLDER = '\u0000queued-message';
/** Upper bound for waiting on an active turn during cancel so the queue cannot stick in `cancelling`. */
const ACTIVE_CANCEL_TIMEOUT_MS = 10_000;

function queueCancellationError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
  readonly suppressUserMessageDisplay?: boolean;
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
  readonly #messagesById = new Map<string, QueuedMessage>();
  readonly #queue: QueueController<QueuedMessageSnapshot, ConversationTerminal> | null;
  #nextQueuedMessageId = 1;
  #nextActionId = 1;
  #activeTurn: Promise<void> = Promise.resolve();
  #activeRequestId: string | null = null;
  #cancellingRequestId: string | null = null;
  /**
   * The active request a steer asked to stop at a safe boundary. The stop stays
   * armed after the steer gives up waiting, so the turn it names may end long
   * afterwards — and when it does, that end is a cancellation, not a failure.
   */
  #steerStopRequestId: string | null = null;
  #cancellation: Promise<void> = Promise.resolve();
  #approvalExecutionId: ExecutionId | null = null;
  #approvalActionId: ActionId | null = null;
  #postExecuteApproval: PostExecuteApprovalToken | null = null;
  #queueStateObserver: QueueStateObserver | null = null;
  #queuedTurnStartObserver: QueuedTurnStartObserver | null = null;
  readonly #activeCancelTimeoutMs: number;

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
    queueCapacity?: number;
    /** Test seam: bound how long cancel waits for a hung active turn. */
    activeCancelTimeoutMs?: number;
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
    this.#activeCancelTimeoutMs = deps.activeCancelTimeoutMs ?? ACTIVE_CANCEL_TIMEOUT_MS;
    if (deps.queueForeground) {
      const driver: QueueTurnDriver<QueuedMessageSnapshot> = {
        start: (execution) => this.#startQueuedTurn(execution),
        cancel: async (_execution, reason = 'cancel') => {
          if (reason === 'steer') {
            // The queue has placed the replacement at its head. Stop the
            // active model/tool sequence before admitting that replacement.
            this.#cancellingRequestId = this.#activeRequestId;
            this.#steerStopRequestId = this.#activeRequestId;
            this.#turnFlow.stopAfterCurrentTool?.();
            // A steer must never start concurrently with a tool that is still
            // settling. When the safe boundary is not reached promptly the
            // active turn keeps running and the queue retains the steer, which
            // then runs at whichever boundary the turn does reach. The stop
            // request stays armed, so `#cancellingRequestId` stays set: a late
            // abort of this turn is a cancellation, not a failure.
            const stopped = await Promise.race([
              this.#activeTurn.then(
                () => true,
                () => true,
              ),
              delay(this.#activeCancelTimeoutMs).then(() => false),
            ]);
            if (!stopped) {
              this.#logger.debug('Steer did not reach a safe boundary; keeping it queued', {
                eventType: 'queue.steer_deferred',
                category: 'conversation',
                sessionId: this.#sessionId,
                timeoutMs: this.#activeCancelTimeoutMs,
              });
            }
            return stopped;
          }
          // Prefer natural abort settlement, but never block queue cancel forever
          // if the underlying turn ignores abort.
          await Promise.race([
            this.#activeTurn.then(
              () => undefined,
              () => undefined,
            ),
            delay(this.#activeCancelTimeoutMs),
          ]);
          return true;
        },
      };
      this.#queue = new QueueController({
        driver,
        snapshotFactory: (item) => {
          const message = this.#messagesById.get(item.id);
          return message ? { requestId: item.id } : { requestId: item.id, recovered: true };
        },
        capacity: deps.queueCapacity,
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

  /** Whether the foreground queue owns a new submission's UI lifecycle. */
  isQueueOwningSubmissions(): boolean {
    if (!this.#queue) return false;
    const state = this.#queue.state();
    return state.kind !== 'idle' || state.queue.length > 0;
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
    if (this.#settingsService.get('app.orchestratorMode')) return 'orchestrator';
    if (this.#settingsService.get('app.liteMode')) return 'lite';
    if (this.#settingsService.get('app.planMode')) return 'plan';
    if (this.#settingsService.get('app.mentorMode')) return 'mentor';
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
      preferredMessageId,
      suppressUserMessageDisplay,
      busyMode,
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
      const requestId = preferredMessageId ?? String(this.#nextQueuedMessageId++);
      if (this.#messagesById.has(requestId)) {
        reject(new Error(`A queued message already uses request id ${requestId}`));
        return;
      }
      const message = {
        input: typeof input === 'string' ? input : structuredClone(input),
        options: {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent,
          hallucinationRetryCount,
          bypassInputSurgeGuard,
          replayFromHistory,
          suppressUserMessageDisplay,
          busyMode,
        },
        resolve,
        reject,
      };
      this.#messagesById.set(requestId, message);
      const displayText = normalizeUserTurn(input).text;
      const controllerText = displayText.trim() ? displayText : QUEUED_NON_TEXT_PLACEHOLDER;
      void queue
        .command({ kind: busyMode === 'steer' ? 'steer' : 'submit', id: requestId, text: controllerText })
        .then((result) => {
          if (result.kind !== 'accepted') {
            const reason = result.kind === 'rejected' ? result.reason : result.kind;
            this.#settleFailure(requestId, new Error(`Foreground queue rejected message: ${reason}`));
          }
          this.#notifyQueueState();
        })
        .catch((error) => {
          this.#settleFailure(requestId, error);
          this.#notifyQueueState();
        });
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
    const queuedIds = this.#queue.state().queue.map((item) => item.id);
    const result = await this.#queue.command({ kind: 'discard_queue' });
    if (result.kind === 'accepted') {
      for (const requestId of queuedIds) {
        this.#settleFailure(requestId, queueCancellationError('Queued message was discarded'));
      }
    }
    this.#notifyQueueState();
  }

  /**
   * Remove the last (most recently queued) item from the queue and return its
   * text so the caller can move it back to the input box. Returns null when
   * the queue is empty, the adapter has no queue (pass-through mode), or the
   * underlying controller rejects the removal.
   *
   * The item is correlated by its controller id, never its queue position.
   */
  async removeLastQueuedItem(): Promise<{ id: string; text: string } | null> {
    const queue = this.#queue;
    if (!queue) return null;

    const state = queue.state();
    if (state.queue.length === 0) return null;

    // The queue is FIFO. The "last" queued item is the one at the tail.
    const lastItem = state.queue[state.queue.length - 1]!;
    // Prefer the in-memory turn text: controller text may be a non-text placeholder.
    const pending = this.#messagesById.get(lastItem.id);
    const restoredText = pending
      ? normalizeUserTurn(pending.input).text
      : lastItem.text === QUEUED_NON_TEXT_PLACEHOLDER || lastItem.text === LEGACY_QUEUED_MESSAGE_PLACEHOLDER
      ? ''
      : lastItem.text;

    const result = await queue.command({ kind: 'remove_queued', itemId: lastItem.id });
    if (result.kind !== 'accepted') return null;
    this.#settleFailure(lastItem.id, queueCancellationError('Queued message was removed'));

    this.#notifyQueueState();
    return { id: lastItem.id, text: restoredText };
  }

  abort(): void {
    if (!this.#queue) {
      this.#turnFlow.abort?.();
      return;
    }
    // Abort the live model/tool turn, then ask the controller to leave running
    // and pause with retained work. If the active turn fails to settle on its
    // own (a hung generator, missing abort hook, etc.), force-settle the active
    // request so orchestrator awaits cannot stick forever. Retained queued
    // requests stay pending — pause is not a terminal fate.
    const activeRequestId = this.#activeRequestId;
    this.#cancellingRequestId = activeRequestId;
    this.#turnFlow.abort?.();
    this.#cancellation = this.#queue.command({ kind: 'cancel' }).then(() => {
      if (activeRequestId && this.#messagesById.has(activeRequestId)) {
        this.#settleFailure(activeRequestId, queueCancellationError('Active turn was cancelled'));
      }
      if (this.#activeRequestId === activeRequestId) {
        this.#activeRequestId = null;
      }
      if (this.#cancellingRequestId === activeRequestId) {
        this.#cancellingRequestId = null;
      }
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
          suppressUserMessageDisplay: message.options.suppressUserMessageDisplay,
        });
      } catch (error) {
        this.#logger.error('queuedTurnStartObserver threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#activeRequestId = execution.snapshot.requestId;
    this.#activeTurn = this.#runQueuedTurn(execution).finally(() => {
      if (this.#activeRequestId === execution.snapshot.requestId) {
        this.#activeRequestId = null;
      }
      if (this.#steerStopRequestId === execution.snapshot.requestId) {
        this.#steerStopRequestId = null;
      }
    });
  }

  /**
   * Run one foreground queue item.
   *
   * Failure policy: a failed active turn emits `failed` to the controller, which
   * pauses the queue (`reason: 'failure'`) whenever retained work remains. The
   * next item does not auto-start; the user must resume or discard. Cancellation
   * of the active turn is the same shape with `reason: 'manual'`.
   */
  async #runQueuedTurn(execution: ActiveExecution<QueuedMessageSnapshot>): Promise<void> {
    const message = this.#messagesById.get(execution.snapshot.requestId);
    try {
      const recoveredInput =
        execution.item.text === QUEUED_NON_TEXT_PLACEHOLDER || execution.item.text === LEGACY_QUEUED_MESSAGE_PLACEHOLDER
          ? null
          : execution.item.text;
      if (!message && !recoveredInput) {
        throw new Error('Recovered queued message has no executable text input');
      }
      const result = await this.#executeMessage(message?.input ?? recoveredInput!, message?.options ?? {});
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
        this.#settleSuccess(execution.snapshot.requestId, result);
        return;
      }
      await this.#queue!.event({ kind: 'completed', executionId: execution.executionId, terminal: result });
      this.#notifyQueueState();
      this.#settleSuccess(execution.snapshot.requestId, result);
    } catch (error) {
      const cancelled = this.#steerStopRequestId === execution.snapshot.requestId;
      const failure =
        cancelled ||
        (this.#cancellingRequestId === execution.snapshot.requestId && error instanceof AmbiguousModelOutcomeError)
          ? queueCancellationError('Active turn was cancelled')
          : error;
      // A turn that ended because a steer asked it to stop is not a failure to
      // review: retiring it lets retained work (the steer that requested the
      // stop) run. Anything else pauses the queue with its retained items.
      await this.#queue!.event(
        cancelled
          ? { kind: 'cancelled', executionId: execution.executionId }
          : { kind: 'failed', executionId: execution.executionId, failure },
      );
      this.#notifyQueueState();
      this.#settleFailure(execution.snapshot.requestId, failure);
    }
  }

  #settleSuccess(requestId: string, terminal: ConversationTerminal): void {
    const message = this.#messagesById.get(requestId);
    if (!message) return;
    this.#messagesById.delete(requestId);
    message.resolve(terminal);
  }

  #settleFailure(requestId: string, error: unknown): void {
    const message = this.#messagesById.get(requestId);
    if (!message) return;
    this.#messagesById.delete(requestId);
    message.reject(error);
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
        this.#subagentEventSinkHost?.cancelSubagentRuns?.();
        this.#subagentEventSinkHost?.setSubagentEventSink(null);
      }

      if (result.type === 'response') {
        this.#logger.debug('sendMessage returning response', {
          sessionId: this.#sessionId,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      this.#postExecuteApproval = result.type === 'approval_required' ? result.approval.postExecute ?? null : null;

      return result;
    });
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, approvalAnswer }: HandleApprovalDecisionOptions = {},
  ): Promise<ConversationTerminal | null> {
    const postExecuteApproval = this.#postExecuteApproval;
    const pendingApproval = this.#approval.getPending();
    if (!pendingApproval && !postExecuteApproval) {
      return null;
    }

    if (postExecuteApproval) {
      const snapshot = this.#approval.getPostExecutePending();
      if (snapshot.sessionId !== postExecuteApproval.sessionId || snapshot.epoch !== postExecuteApproval.epoch) {
        return null;
      }
      const decision = this.#approval.decidePostExecutePending({
        revision: postExecuteApproval.revision,
        ids: postExecuteApproval.ids,
        decision:
          answer === 'y'
            ? 'approve'
            : answer === 'allow-once' || answer === 'allow-remember' || answer === 'unsandboxed-once'
            ? answer
            : 'reject',
      });
      if (decision.kind !== 'settled') return null;
      this.#postExecuteApproval = null;
    }

    if (answer === 'y' && approvalAnswer) {
      const callId = pendingApproval ? getCallIdFromObject(pendingApproval.interruption) : undefined;
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

      // Queue resolution may await persistence while abort/new-turn work replaces
      // the pending approval. A decision captured for the old approval must not
      // adopt whichever approval happens to be current when continuation starts.
      if (!postExecuteApproval) {
        const currentApproval = this.#approval.getPending();
        const sameApproval =
          pendingApproval?.token !== undefined
            ? currentApproval?.token === pendingApproval.token
            : currentApproval === pendingApproval;
        if (!sameApproval) return null;
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
          result = await collectTerminalResult(
            postExecuteApproval
              ? this.#turnFlow.continueAfterPostExecuteApproval!()
              : this.#turnFlow.continueAfterApproval({ answer, rejectionReason }),
            {
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
            },
          );
        } finally {
          this.#subagentEventSinkHost?.cancelSubagentRuns?.();
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
      this.#postExecuteApproval = result?.type === 'approval_required' ? result.approval.postExecute ?? null : null;
      if (result && this.#queue && this.#approvalExecutionId) {
        const executionId = this.#approvalExecutionId;
        if (result.type === 'approval_required') {
          // A continuation may request another tool approval. Keep the same
          // queue execution active and replace its resolved action rather than
          // retiring it and dispatching the next message while the turn is
          // still awaiting approval.
          this.#approvalActionId = `adapter-action-${this.#nextActionId++}` as ActionId;
          await this.#queue.event({
            kind: 'tool_approval_requested',
            executionId,
            actionId: this.#approvalActionId,
            request: {},
          });
          this.#notifyQueueState();
        } else {
          this.#approvalExecutionId = null;
          this.#approvalActionId = null;
          await this.#queue.event({ kind: 'completed', executionId, terminal: result });
          this.#notifyQueueState();
        }
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
