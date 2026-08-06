import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal, PostExecuteApprovalToken } from '../../contracts/conversation.js';
import { collectTerminalResult } from '../session/terminal-result-collector.js';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import { userTurnToProviderItem } from './user-turn-item.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { SessionRuntime, SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { SessionManager } from '../session/session-manager.js';
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
        cancel: async () => {
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
      // `retractSteer` is optional on `TurnFlow` only so a `turnFlow` that
      // implements `steer` alone still type-checks; whatever actually called
      // `injectIntoActiveTurn` with this id required `turnFlow.steer` to
      // exist, so it must have also wired `retractSteer`. An id landing here
      // with the method missing is a wiring bug, not a race — reporting it as
      // `too_late` would tell the user "already sent" about a submission the
      // run loop never got a chance to admit or refuse (## Resume here,
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
      // Same invariant as `retractSubmission`: a `turnFlow` that wires `steer`
      // for a pending id must also wire `editSteer` (## Resume here, hazard 3).
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
        const previous = this.#messagesById.get(id);
        if (!previous) return { kind: 'unknown_id' };
        this.#messagesById.set(id, { ...previous, input: structuredClone(turn) });
        const displayText = normalizeUserTurn(turn).text;
        const controllerText = displayText.trim() ? displayText : QUEUED_NON_TEXT_PLACEHOLDER;
        const result = await this.#queue.command({ kind: 'edit_queued', itemId: id as ItemId, text: controllerText });
        if (result.kind !== 'accepted') {
          // The stage transition must be all-or-nothing (## Resume here,
          // hazard 2): if the controller refused the edit — most likely
          // because the item started running during the await above — the
          // write to `#messagesById` above must not stick, or the turn that
          // is (or is about to be) reading that entry sends the edited text
          // while the caller is simultaneously told `too_late` and, per
          // `## Losing the race`, resubmits the same text as a fresh
          // message — sending it twice. Restore the pre-edit entry, unless
          // the item has already settled and removed itself from the map
          // (nothing left to restore, and doing so would resurrect a
          // promise that already resolved).
          if (this.#messagesById.has(id)) {
            this.#messagesById.set(id, previous);
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
   * A thin wrapper over {@link retractSubmission} addressed at the controller
   * queue's tail id — kept only because `InputBox`'s up-arrow gesture is
   * still its sole caller (Step 4 replaces both with the id-addressed
   * `PendingQueueList`). It still only looks at the *controller* queue, not a
   * pending steer, so a steer with no queued follow-up behind it remains
   * unreachable here exactly as before — that gap is defect #1 in the design
   * doc, left for Step 4 to close via the unified pending list.
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

    const result = await this.retractSubmission(lastItem.id);
    if (result.kind !== 'applied') return null;
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
      const failure =
        this.#cancellingRequestId === execution.snapshot.requestId && error instanceof AmbiguousModelOutcomeError
          ? queueCancellationError('Active turn was cancelled')
          : error;
      // Controller pauses with retained queue on failure when work remains.
      await this.#queue!.event({ kind: 'failed', executionId: execution.executionId, failure });
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
