import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ApprovalRequiredEvent, ConversationEvent, ConversationEventSink } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal, PendingApproval, PostExecuteApprovalToken } from '../../contracts/conversation.js';
import { collectTerminalResult, TerminalResultCollectorExhaustionError } from '../session/terminal-result-collector.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import type { InputSurgeApproval } from '../input-surge-approval.js';
import { userTurnToProviderItem } from './user-turn-item.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { SessionRuntime, SessionLogs, SessionApprovalQuery } from '../../core/index.js';
import type { SessionManager } from '../session/session-manager.js';
import type { PendingInteractionState } from '../session/pending-interaction-state.js';
import type { AskUserAnswerSink, SubagentEventSinkHost } from '../conversation-agent-client.js';
import {
  QueueController,
  type ActionId,
  type ActiveExecution,
  type ExecutionId,
  type ItemId,
  type QueuePersistence,
  type QueueTurnDriver,
} from '../queue/queue-controller.js';

export type SendMessageOptions = {
  /** Internal admission callback; called when a queued submission is accepted or rejected. */
  onAdmission?: (error?: unknown) => void;
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: ConversationEventSink;
  hallucinationRetryCount?: number;
  inputSurgeApproval?: InputSurgeApproval;
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
  onEvent?: ConversationEventSink;
  approvalAnswer?: string;
  /**
   * End the turn once this decision's tool result is recorded, without giving
   * the model another turn. Cancelling an `ask_user` prompt uses this so the
   * question and its unanswered result stay in history.
   */
  stopAfterApprovalResolution?: boolean;
};

export type TurnFlow = Pick<SessionRuntime['turns'], 'start' | 'continueAfterApproval'> & {
  continueAfterPostExecuteApproval?: SessionRuntime['turns']['continueAfterPostExecuteApproval'];
  abort?: () => void | Promise<void>;
  steer?: SessionRuntime['turns']['steer'];
  retractSteer?: SessionRuntime['turns']['retractSteer'];
  editSteer?: SessionRuntime['turns']['editSteer'];
};

/**
 * Which of the three stages (`## The three stages` in the design doc) a
 * submission currently lives in. `'started'` covers both the active
 * execution and a steer that was already admitted — from the caller's
 * perspective both are equally too late to mutate.
 */
export type SubmissionStage = 'pending_steer' | 'queued' | 'started';

/**
 * Outcome of `retractSubmission`/`editSubmission`. A typed result rather than
 * a bare boolean because "it was already running" and "I have never heard of
 * this id" are different things the UI reports differently.
 */
export type SubmissionMutation =
  | { readonly kind: 'applied'; readonly stage: 'pending_steer' | 'queued' }
  | { readonly kind: 'too_late'; readonly stage: 'started' }
  | { readonly kind: 'unknown_id' };

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

export type { ConversationEventSink } from './conversation-events.js';

export type PreparedMessageIds = { readonly turnId: string; readonly clientRequestId: string };
export type PreparedMessageResult =
  | { readonly kind: 'prepared'; readonly leaseId: string; readonly turnId: string }
  | { readonly kind: 'rejected'; readonly reason: 'busy' | 'queue_full' | 'closed' };

export type AbortDiscardResult = {
  readonly discardedTurnIds: string[];
  readonly proven: boolean;
};

export class AdmissionLeaseError extends Error {
  readonly code: 'stale' | 'wrong_session' | 'already_settled' | 'closed';
  constructor(code: AdmissionLeaseError['code']) {
    super('message admission lease rejected');
    this.name = 'AdmissionLeaseError';
    this.code = code;
  }
}

type PreparedMessage = {
  readonly input: string | UserTurn;
  readonly turnId: string;
  readonly clientRequestId: string;
  readonly expiresAt: number;
};

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
  #pendingInteraction: Pick<PendingInteractionState, 'present' | 'clear' | 'getSnapshot'> | null;
  #turnFlow: TurnFlow;
  readonly #messagesById = new Map<string, QueuedMessage>();
  /**
   * Ids currently handed to `turnFlow.steer` and not yet settled. Populated
   * right before the call and cleared when that steer's promise resolves
   * (admitted, released, or retracted) — this is what lets
   * `retractSubmission`/`editSubmission` tell a pending steer apart from a
   * queued item sharing the same id space, per `## The three stages`.
   */
  readonly #pendingSteerIds = new Set<string>();
  readonly #queue: QueueController<QueuedMessageSnapshot, ConversationTerminal> | null;
  #nextQueuedMessageId = 1;
  #nextActionId = 1;
  #activeTurn: Promise<void> = Promise.resolve();
  #activeRequestId: string | null = null;
  #cancellingRequestId: string | null = null;
  #cancellationEpoch = 0;
  #cancellation: Promise<void> = Promise.resolve();
  #cancellationProven = true;
  #activeAbortCompletion: Promise<void> | null = null;
  #approvalExecutionId: ExecutionId | null = null;
  #approvalActionId: ActionId | null = null;
  #postExecuteApproval: PostExecuteApprovalToken | null = null;
  #queueStateObserver: QueueStateObserver | null = null;
  #queuedTurnStartObserver: QueuedTurnStartObserver | null = null;
  #compactionAbort: AbortController | null = null;
  readonly #activeCancelTimeoutMs: number;
  readonly #queueCapacity: number;
  readonly #preparedLeaseTtlMs: number;
  readonly #discardOnFailure: boolean;
  readonly #failureDiscardedTurnIds: string[] = [];
  readonly #preparedMessages = new Map<string, PreparedMessage>();
  readonly #cancelledLeases = new Set<string>();
  #admissionClosed = false;

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
    /** Session-owned interaction projection; omitted by low-level legacy tests. */
    pendingInteraction?: Pick<PendingInteractionState, 'present' | 'clear' | 'getSnapshot'>;
    turnFlow: TurnFlow;
    queueForeground?: boolean;
    queueCapacity?: number;
    /** Test seam: bound how long cancel waits for a hung active turn. */
    activeCancelTimeoutMs?: number;
    /** Gateway-only finite reservation policy; legacy callers retain Infinity. */
    preparedLeaseTtlMs?: number;
    discardOnFailure?: boolean;
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
    this.#pendingInteraction = deps.pendingInteraction ?? null;
    this.#turnFlow = deps.turnFlow;
    this.#activeCancelTimeoutMs = deps.activeCancelTimeoutMs ?? ACTIVE_CANCEL_TIMEOUT_MS;
    this.#queueCapacity = deps.queueCapacity ?? Infinity;
    this.#preparedLeaseTtlMs = deps.preparedLeaseTtlMs ?? 10_000;
    this.#discardOnFailure = deps.discardOnFailure === true;
    if (deps.queueForeground) {
      const driver: QueueTurnDriver<QueuedMessageSnapshot> = {
        start: (execution) => this.#startQueuedTurn(execution),
        cancel: async () => {
          // Prefer natural abort settlement, but report whether the bounded
          // barrier actually proved that the active execution stopped.
          const result = await Promise.race([
            (this.#activeAbortCompletion ?? this.#activeTurn).then(
              () => true,
              () => true,
            ),
            delay(this.#activeCancelTimeoutMs).then(() => false),
          ]);
          return result;
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
    if (this.#queue.isDispatchHeld()) return true;
    const state = this.#queue.state();
    return state.kind !== 'idle' || state.queue.length > 0;
  }

  /**
   * Occupy the foreground queue the way an in-flight turn does, so new
   * submits enqueue instead of starting. False when a turn already owns it.
   */
  holdForegroundQueue(): boolean {
    if (!this.#queue) return true;
    const held = this.#queue.holdDispatch();
    if (held) this.#notifyQueueState();
    return held;
  }

  releaseForegroundQueue(options: { pauseIfQueued?: boolean } = {}): void {
    this.#queue?.releaseDispatch(options);
    this.#notifyQueueState();
  }

  attachCompactionAbort(controller: AbortController): void {
    this.#compactionAbort = controller;
  }

  detachCompactionAbort(controller: AbortController): void {
    if (this.#compactionAbort === controller) this.#compactionAbort = null;
  }

  /**
   * The queue's current state kind, for diagnostics only.
   *
   * `isQueueOwningSubmissions` and `isQueueActive` disagree on several states —
   * a submission can be owned by the queue (so the UI shows it as queued) while
   * the queue is not active (so a steer is refused before it is ever offered to
   * the turn). This names the state so that gap is visible in the logs.
   */
  queueStateKind(): QueueStateKind | 'none' {
    return this.#queue ? this.#queue.state().kind : 'none';
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

  /**
   * Deliver a user message into the turn already running, as a user message the
   * model reads after the tool results of the round in flight.
   *
   * Resolves true once the running turn has taken it. Resolves false when that
   * turn offers no further request boundary — it is finishing, or parked on an
   * approval — leaving the caller to send the message as its own turn.
   *
   * `options.id` is the submission's address (see `## The three stages`):
   * while this call is outstanding, `id` is tracked in `#pendingSteerIds` so
   * `retractSubmission`/`editSubmission` can route to it. Omitted by the one
   * caller that has no such id — background subagent notifications, via
   * `injectIntoActiveTurn` directly — which can never be retracted or edited.
   */
  async steerActiveTurn(input: string | UserTurn, options?: { id?: string }): Promise<boolean> {
    const turn = normalizeUserTurn(input);
    if (!turn.text.trim() && !turn.images?.length) return false;
    return this.injectIntoActiveTurn([userTurnToProviderItem(turn, { steering: true })], options);
  }

  /**
   * Hand pre-built items to the turn already running, admitted at its next
   * request boundary.
   *
   * Steering is the user's case of this; a settled background subagent run and
   * shell-session context are the same act by a different speaker, so they
   * share the delivery and differ only in the text they carry. Resolves false
   * when no turn will take them, leaving the caller to deliver them itself.
   *
   * Keeps its boolean signature regardless of caller: the run loop's
   * `SteerOutcome` union is collapsed here to `'admitted' → true`, everything
   * else `→ false`. Only `retractSubmission`/`editSubmission` need the richer
   * outcome, and they get it by calling `retractSteer`/`editSteer` directly.
   */
  async injectIntoActiveTurn(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<boolean> {
    if (!this.#turnFlow.steer || items.length === 0) return false;
    if (!this.isQueueActive()) return false;
    const id = options?.id;
    if (id) this.#pendingSteerIds.add(id);
    try {
      const outcome = await this.#turnFlow.steer(items, id ? { id } : undefined);
      return outcome === 'admitted';
    } finally {
      if (id) this.#pendingSteerIds.delete(id);
    }
  }

  /**
   * Retract a submission before it reaches the model, addressed by the id
   * `sendMessage`/`steerActiveTurn` were given (`preferredMessageId`), which
   * is the same id the UI already keys `pendingQueuedMessages` on.
   *
   * Routes by stage (`## The three stages`): a still-waiting steer goes to
   * `retractSteer` on the run loop; a queued item goes to the controller's
   * `remove_queued`.
   *
   * A pending steer has no matching `#messagesById` entry to settle — its
   * caller (`steerActiveTurn`) awaits the `turnFlow.steer` promise directly,
   * not a queued `sendMessage`. `retractSteer` resolves that promise itself
   * (with `'retracted'`), which `injectIntoActiveTurn` reports as `false` to
   * that caller. A queued item, by contrast, *does* have a `sendMessage`
   * promise parked in `#messagesById`, which this settles with an
   * `AbortError` — the same shape `removeLastQueuedItem` already used.
   */
  async retractSubmission(id: string): Promise<SubmissionMutation> {
    if (this.#pendingSteerIds.has(id)) {
      if (!this.#turnFlow.retractSteer) {
        throw new Error(
          `ConversationAdapter.retractSubmission: pending steer '${id}' has no turnFlow.retractSteer to route to`,
        );
      }
      const retracted = this.#turnFlow.retractSteer(id);
      if (!retracted) return { kind: 'too_late', stage: 'started' };
      this.#pendingSteerIds.delete(id);
      return { kind: 'applied', stage: 'pending_steer' };
    }
    if (this.#queue) {
      const inQueue = this.#queue.state().queue.some((item) => item.id === id);
      if (inQueue) {
        const result = await this.#queue.command({ kind: 'remove_queued', itemId: id as ItemId });
        if (result.kind !== 'accepted') return { kind: 'too_late', stage: 'started' };
        this.#settleFailure(id, queueCancellationError('Queued message was removed'));
        this.#notifyQueueState();
        return { kind: 'applied', stage: 'queued' };
      }
    }
    if (this.#messagesById.has(id)) return { kind: 'too_late', stage: 'started' };
    return { kind: 'unknown_id' };
  }

  /**
   * Replace a submission's content in place, without changing its stage or
   * position — a pending steer stays a steer at its slot, a queued item keeps
   * its queue index and steer-ahead-of-follow-ups priority.
   *
   * **The trap**: the controller queue stores display `text` only.
   * `#runQueuedTurn` executes `message.input` from `#messagesById`, so
   * issuing `edit_queued` alone redraws the new text but sends the old turn.
   * This replaces the `#messagesById` entry's `input` first, keeping the
   * `QUEUED_NON_TEXT_PLACEHOLDER` substitution `sendMessage` applies to the
   * controller's display copy.
   */
  async editSubmission(id: string, turn: UserTurn): Promise<SubmissionMutation> {
    if (this.#pendingSteerIds.has(id)) {
      if (!this.#turnFlow.editSteer) {
        throw new Error(
          `ConversationAdapter.editSubmission: pending steer '${id}' has no turnFlow.editSteer to route to`,
        );
      }
      const item = userTurnToProviderItem(normalizeUserTurn(turn), { steering: true });
      const edited = this.#turnFlow.editSteer(id, [item]);
      return edited ? { kind: 'applied', stage: 'pending_steer' } : { kind: 'too_late', stage: 'started' };
    }
    if (this.#queue) {
      const inQueue = this.#queue.state().queue.some((item) => item.id === id);
      if (inQueue) {
        const message = this.#messagesById.get(id);
        if (!message) return { kind: 'unknown_id' };
        const { inputSurgeApproval: _invalidatedApproval, ...options } = message.options;
        this.#messagesById.set(id, { ...message, input: structuredClone(turn), options });
        const displayText = normalizeUserTurn(turn).text;
        const controllerText = displayText.trim() ? displayText : QUEUED_NON_TEXT_PLACEHOLDER;
        const result = await this.#queue.command({ kind: 'edit_queued', itemId: id as ItemId, text: controllerText });
        if (result.kind !== 'accepted') {
          if (this.#messagesById.has(id)) {
            this.#messagesById.set(id, message);
          }
          return { kind: 'too_late', stage: 'started' };
        }
        this.#notifyQueueState();
        return { kind: 'applied', stage: 'queued' };
      }
    }
    if (this.#messagesById.has(id)) return { kind: 'too_late', stage: 'started' };
    return { kind: 'unknown_id' };
  }

  async sendMessage(
    input: string | UserTurn,
    {
      onAdmission,
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
      inputSurgeApproval,
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
        inputSurgeApproval,
        replayFromHistory,
      }).then(async (result) => {
        await this.#recordPendingInteraction(result);
        return result;
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
          inputSurgeApproval,
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
        .then(async (result) => {
          if (result.kind !== 'accepted') {
            const reason = result.kind === 'rejected' ? result.reason : result.kind;
            const error = new Error(`Foreground queue rejected message: ${reason}`);
            onAdmission?.(error);
            await this.#eventSink?.({ type: 'error', message: error.message, kind: 'admission_rejected' });
            this.#settleFailure(requestId, error);
          } else {
            onAdmission?.();
          }
          this.#notifyQueueState();
        })
        .catch((error) => {
          onAdmission?.(error);
          this.#settleFailure(requestId, error);
          this.#notifyQueueState();
        });
    });
  }

  async prepareMessage(input: string | UserTurn, ids: PreparedMessageIds): Promise<PreparedMessageResult> {
    const now = Date.now();
    for (const [leaseId, prepared] of this.#preparedMessages) {
      if (prepared.expiresAt <= now) this.#preparedMessages.delete(leaseId);
    }
    if (this.#admissionClosed) return { kind: 'rejected', reason: 'closed' };
    if (
      !ids.turnId ||
      !ids.clientRequestId ||
      [...this.#preparedMessages.values()].some(
        (prepared) => prepared.turnId === ids.turnId || prepared.clientRequestId === ids.clientRequestId,
      )
    ) {
      return { kind: 'rejected', reason: 'busy' };
    }
    const state = this.#queue?.state();
    if (!this.#queue && this.isQueueActive()) return { kind: 'rejected', reason: 'busy' };
    if (state && state.queue.length + this.#preparedMessages.size >= this.#queueCapacity) {
      return { kind: 'rejected', reason: 'queue_full' };
    }
    const leaseId = crypto.randomUUID();
    this.#preparedMessages.set(leaseId, {
      input: typeof input === 'string' ? input : structuredClone(input),
      turnId: ids.turnId,
      clientRequestId: ids.clientRequestId,
      expiresAt: Date.now() + this.#preparedLeaseTtlMs,
    });
    return { kind: 'prepared', leaseId, turnId: ids.turnId };
  }

  async commitMessage(leaseId: string): Promise<void> {
    if (this.#admissionClosed) throw new AdmissionLeaseError('closed');
    const prepared = this.#preparedMessages.get(leaseId);
    if (!prepared) throw new AdmissionLeaseError('stale');
    if (prepared.expiresAt <= Date.now()) {
      this.#preparedMessages.delete(leaseId);
      throw new AdmissionLeaseError('stale');
    }
    this.#preparedMessages.delete(leaseId);
    await new Promise<void>((resolve, reject) => {
      const terminal = this.sendMessage(prepared.input, {
        preferredMessageId: prepared.turnId,
        onAdmission: (error) => (error ? reject(error) : resolve()),
      });
      // The admission callback reports queue rejection; this handler prevents
      // the later terminal rejection from becoming an unhandled promise.
      terminal.then(
        () => undefined,
        () => undefined,
      );
    });
  }

  async cancelPreparedMessage(leaseId: string): Promise<void> {
    if (this.#admissionClosed) throw new AdmissionLeaseError('closed');
    if (this.#cancelledLeases.has(leaseId)) return;
    const prepared = this.#preparedMessages.get(leaseId);
    if (!prepared) throw new AdmissionLeaseError('stale');
    this.#preparedMessages.delete(leaseId);
    if (prepared.expiresAt <= Date.now()) throw new AdmissionLeaseError('stale');
    this.#cancelledLeases.add(leaseId);
  }

  async abortAndDiscard(): Promise<AbortDiscardResult> {
    const discarded = [...this.#preparedMessages.values()].map((item) => item.turnId);
    this.#preparedMessages.clear();
    this.abort();
    await this.#cancellation;
    if (this.#queue) {
      discarded.push(...this.#queue.state().queue.map((item) => item.id));
      await this.discardQueue();
    }
    return { discardedTurnIds: [...new Set(discarded)], proven: this.#cancellationProven };
  }

  closeAdmission(): string[] {
    this.#admissionClosed = true;
    const discarded = [...this.#preparedMessages.values()].map((item) => item.turnId);
    this.#preparedMessages.clear();
    return discarded;
  }

  reopenAdmission(): void {
    if (this.#cancellationProven) this.#admissionClosed = false;
  }

  preparedMessageCount(): number {
    return this.#preparedMessages.size;
  }

  consumeFailureDiscardedTurnIds(): string[] {
    const discarded = [...new Set(this.#failureDiscardedTurnIds)];
    this.#failureDiscardedTurnIds.length = 0;
    return discarded;
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

  abort(): void {
    this.#compactionAbort?.abort();
    this.#cancellationEpoch++;
    this.#pendingInteraction?.clear();
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
    this.#activeAbortCompletion = Promise.resolve(this.#turnFlow.abort?.());
    this.#cancellationProven = true;
    this.#cancellation = this.#queue.command({ kind: 'cancel' }).then((result) => {
      this.#cancellationProven = result.kind !== 'rejected' || result.reason !== 'cancellation_unproven';
      if (this.#cancellationProven && activeRequestId && this.#messagesById.has(activeRequestId)) {
        this.#settleFailure(activeRequestId, queueCancellationError('Active turn was cancelled'));
      }
      if (this.#cancellationProven && this.#activeRequestId === activeRequestId) {
        this.#activeRequestId = null;
      }
      if (this.#cancellationProven && this.#cancellingRequestId === activeRequestId) {
        this.#cancellingRequestId = null;
      }
      if (this.#cancellationProven) this.#activeAbortCompletion = null;
      this.#notifyQueueState();
    });
  }

  #startQueuedTurn(execution: ActiveExecution<QueuedMessageSnapshot>): void {
    // Notify the orchestrator/UI before kicking off the run so that the user
    // message can be appended to the message list with the correct timeline.
    // Recovered items have no #messagesById entry; still fire so a delivered
    // row cannot stay in the pending list after the queue has started it.
    const message = this.#messagesById.get(execution.snapshot.requestId);
    if (this.#queuedTurnStartObserver) {
      try {
        this.#queuedTurnStartObserver({
          requestId: execution.snapshot.requestId,
          input: message?.input ?? execution.item.text,
          suppressUserMessageDisplay: message?.options.suppressUserMessageDisplay,
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
      const result = await this.#executeMessage(
        message?.input ?? recoveredInput!,
        message?.options ?? {},
        execution.snapshot.requestId,
      );
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
        await this.#recordPendingInteraction(result);
        this.#settleSuccess(execution.snapshot.requestId, result);
        return;
      }
      await this.#queue!.event({ kind: 'completed', executionId: execution.executionId, terminal: result });
      this.#notifyQueueState();
      await this.#recordPendingInteraction(result);
      this.#settleSuccess(execution.snapshot.requestId, result);
    } catch (error) {
      const failure =
        this.#cancellingRequestId === execution.snapshot.requestId &&
        error instanceof TerminalResultCollectorExhaustionError
          ? queueCancellationError('Active turn was cancelled')
          : error;
      // Controller pauses with retained queue on failure when work remains.
      try {
        await this.#queue!.event({ kind: 'failed', executionId: execution.executionId, failure });
        if (this.#discardOnFailure) {
          this.#failureDiscardedTurnIds.push(...this.#queue!.state().queue.map((item) => item.id));
          await this.discardQueue();
        }
        this.#notifyQueueState();
      } catch (queueError) {
        this.#logger.error('Failed to settle queued turn failure state', {
          error: queueError instanceof Error ? queueError.message : String(queueError),
        });
      }
      try {
        await this.#eventSink?.({
          type: 'error',
          message: failure instanceof Error ? failure.message : String(failure),
          kind: 'turn_failed',
        });
      } catch (eventError) {
        // The failure event is itself critical at the gateway boundary. It
        // must not prevent the owning submission from settling or leave
        // #activeTurn as an unhandled rejection.
        this.#logger.error('Failed to publish queued turn failure event', {
          error: eventError instanceof Error ? eventError.message : String(eventError),
        });
      } finally {
        this.#settleFailure(execution.snapshot.requestId, failure);
      }
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

  async #collectTerminalResult(
    events: AsyncIterable<ConversationEvent>,
    options: Parameters<typeof collectTerminalResult>[1],
    cancellationEpoch: number,
    requestId?: string | null,
  ): Promise<ConversationTerminal> {
    try {
      return await collectTerminalResult(events, options);
    } catch (error) {
      const wasCancelled =
        error instanceof TerminalResultCollectorExhaustionError &&
        (cancellationEpoch < this.#cancellationEpoch ||
          (Boolean(requestId) && this.#cancellingRequestId === requestId));
      if (wasCancelled) {
        throw queueCancellationError('Active turn was cancelled');
      }
      throw error;
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
      inputSurgeApproval,
      replayFromHistory,
    }: SendMessageOptions = {},
    requestId?: string | null,
  ): Promise<ConversationTerminal> {
    const turn = normalizeUserTurn(input);
    const cancellationEpoch = this.#cancellationEpoch;
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = async (event: ConversationEvent): Promise<void> => {
        if (event.type === 'approval_required') {
          // Install the authoritative session snapshot before any gateway/UI
          // sink sees the approval event. The runtime retains the private
          // interruption in SessionApprovalQuery; this public event carries
          // only its already-sanitized descriptor shape.
          this.#pendingInteraction?.present({
            ...(event.approval as PendingApproval),
            rawInterruption: null,
          });
        }
        await this.#eventSink?.(event);
        this.#logs.dispatchEventToLog(event);
        await onEvent?.(event);
      };
      let result: ConversationTerminal;
      try {
        await this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
        const startOptions: any = { retries: { hallucinationRetryCount } };
        if (inputSurgeApproval !== undefined) {
          startOptions.inputSurgeApproval = inputSurgeApproval;
        }
        if (replayFromHistory) {
          startOptions.replayFromHistory = true;
        }
        result = await this.#collectTerminalResult(
          this.#turnFlow.start(input, startOptions),
          {
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
          },
          cancellationEpoch,
          requestId,
        );
      } finally {
        this.#subagentEventSinkHost?.cancelSubagentRuns?.();
        await this.#subagentEventSinkHost?.setSubagentEventSink(null);
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
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      approvalAnswer,
      stopAfterApprovalResolution,
    }: HandleApprovalDecisionOptions = {},
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

    // This facade is also used directly by non-interactive callers. Clear the
    // session projection here as well as through the interactive semantic
    // resolver, so the continuation API remains self-contained.
    this.#pendingInteraction?.clear();

    this.#logs.log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    // Capture before resolving the queue action: persistence may await while
    // an abort invalidates this approval and makes the coordinator idle.
    const cancellationEpoch = this.#cancellationEpoch;
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

      if (cancellationEpoch < this.#cancellationEpoch) {
        throw queueCancellationError('Approval decision was cancelled');
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
        const wrappedOnEvent = async (event: ConversationEvent): Promise<void> => {
          if (event.type === 'approval_required') {
            // Install the authoritative session snapshot before any gateway/UI
            // sink sees the approval event. The runtime retains the private
            // interruption in SessionApprovalQuery; this public event carries
            // only its already-sanitized descriptor shape.
            this.#pendingInteraction?.present({
              ...(event.approval as PendingApproval),
              rawInterruption: null,
            });
          }
          await this.#eventSink?.(event);
          this.#logs.dispatchEventToLog(event);
          await onEvent?.(event);
        };
        let result: ConversationTerminal | null;
        try {
          await this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
          result = await this.#collectTerminalResult(
            postExecuteApproval
              ? this.#turnFlow.continueAfterPostExecuteApproval!()
              : this.#turnFlow.continueAfterApproval({
                  answer,
                  rejectionReason,
                  ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
                }),
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
            cancellationEpoch,
            this.#activeRequestId,
          );
        } finally {
          this.#subagentEventSinkHost?.cancelSubagentRuns?.();
          await this.#subagentEventSinkHost?.setSubagentEventSink(null);
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
      if (result) await this.#recordPendingInteraction(result);
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

  async #recordPendingInteraction(result: ConversationTerminal): Promise<void> {
    if (result.type === 'approval_required') {
      // The event bridge presents before publication. Keep a fallback for
      // terminal/test paths that return an approval without emitting its event,
      // but never replace an already-live snapshot (which would change its
      // optimistic-concurrency ID).
      if (!this.#pendingInteraction?.getSnapshot?.()) {
        const safeApproval = { ...result.approval, rawInterruption: null };
        this.#pendingInteraction?.present(safeApproval);
        const approvalEvent: ApprovalRequiredEvent = { type: 'approval_required', approval: safeApproval };
        await this.#eventSink?.(approvalEvent);
      }
    } else {
      this.#pendingInteraction?.clear();
    }
  }
}
