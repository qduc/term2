/**
 * The open chat: its `Term2SessionStore` (stream, checkpoint, snapshot), its presented view and the requests that act
 * on it, with their feedback (docs/plans/web-client/web-shell-decomposition.md, section 4.5). It replaces the
 * `useTerm2Session` hook; the method bodies are the hook's callbacks, moved. The shell runtime calls `open()` when
 * the machine's open chat changes, before anything renders, so one render never shows the new chat with the old
 * chat's transcript. No React here.
 */
import { diagnosticsOn } from '../browser-prefs';
import { term2Client, Term2ApiError } from '../../api/term2';
import { Term2SessionStore } from '../session-store';
import { createStore, type ReadableStore, type Store } from '../store';
import type {
  InteractionResolveRequest,
  MessageSubmitOptions,
  QueueManageAction,
  TaskControlAction,
  Term2CommandId,
  Term2CommandResult,
  Term2ConnectionStatus,
  Term2SessionView,
} from '../types';

/** The view of no session at all. */
export const NO_SESSION: Term2SessionView = {
  sessionId: '',
  turns: [],
  pendingInteraction: null,
  status: 'idle',
  lastAppliedSequence: 0,
  error: null,
  reloadRequired: false,
};

// Messages need a live session stream to observe their accepted outcome.
export function canSubmitSessionMessage(status: Term2ConnectionStatus): boolean {
  return status === 'connected' || status === 'running' || status === 'interrupted';
}

const COMMAND_ERROR_MESSAGES: Record<string, string> = {
  session_busy: 'The session is busy; wait for the current turn to finish.',
  session_not_admitting: 'The session is not accepting commands right now.',
  command_not_allowed: 'That command is not allowed for this session.',
  compact_failed: 'Compacting the context failed.',
  compact_interrupted: 'A previous compaction was interrupted; reload the session.',
  compact_invalid_state: 'The session compaction state is inconsistent.',
  retry_failed: 'The retry failed.',
  idempotency_conflict: 'That command conflicts with an earlier request.',
};

const NOTHING_TO_RETRY_MESSAGES: Record<Term2CommandId, string> = {
  compact: 'Nothing to compact yet.',
  rollover: 'Nothing to roll over yet.',
  'retry-tool': 'No tool output is available to retry.',
  'retry-turn': 'No failed turn is available to retry.',
};

// Contract 13 §8 bounds a compaction failure to these codes; any unknown code
// still renders readably, so a new gateway code degrades to its own words.
const COMPACTION_FAILURE_REASONS: Record<string, string> = {
  busy: 'the session was busy',
  cancelled: 'the compaction was cancelled',
  native_failed: "the provider's compaction failed",
  single_turn_too_large: 'a single turn is too large to compact',
  result_still_too_large: 'the compacted context would still be too large',
  hot_tail_would_orphan_tool_result: 'the hot tail would orphan a tool result',
};

function commandNoticeFor(
  commandId: Term2CommandId,
  result: Term2CommandResult,
): { tone: 'neutral' | 'error'; message: string } {
  if (result.outcome === 'nothing_to_retry') return { tone: 'neutral', message: NOTHING_TO_RETRY_MESSAGES[commandId] };
  if (commandId === 'rollover') return { tone: 'neutral', message: 'Started a fresh context.' };
  if (result.outcome === 'not_reduced') return { tone: 'neutral', message: "Compaction didn't reduce the context." };
  if (result.outcome === 'failed') {
    const detail = result.reason
      ? COMPACTION_FAILURE_REASONS[result.reason] ?? result.reason.replace(/_/gu, ' ')
      : 'the reason was not reported';
    return { tone: 'error', message: `Compaction failed: ${detail}.` };
  }
  const tokens =
    result.tokensBefore !== undefined && result.tokensAfter !== undefined
      ? ` (${result.tokensBefore} → ${result.tokensAfter} tokens)`
      : '';
  return { tone: 'neutral', message: `Context compacted${tokens}.` };
}

const INTERACTION_CONFLICT_MESSAGES = {
  stale_interaction: 'This interaction is stale. The latest interaction state was reloaded.',
  interaction_already_resolved: 'This interaction was already resolved.',
  interaction_not_resolvable: 'This interaction cannot be resolved safely.',
} as const;

/** Keyed by session, so a request still in flight for the previous chat cannot speak for the one now open. */
export type SessionFeedback = {
  readonly submitError: { readonly sessionId: string; readonly message: string } | null;
  readonly command: { readonly sessionId: string; readonly tone: 'neutral' | 'error'; readonly message: string } | null;
  readonly commandPendingSessionId: string | null;
};

export class OpenSession {
  readonly feedback: Store<SessionFeedback> = createStore<SessionFeedback>({
    submitError: null,
    command: null,
    commandPendingSessionId: null,
  });
  readonly view: ReadableStore<Term2SessionView>;
  readonly #chatTitled: (sessionId: string, firstLine: string) => void;
  #sessionId: string | null = null;
  #store: Term2SessionStore | null = null;
  #unsubscribe: (() => void) | null = null;
  #started = false;
  readonly #listeners = new Set<() => void>();
  readonly #admitting = new Set<string>();

  constructor(deps: { chatTitled(sessionId: string, firstLine: string): void }) {
    this.#chatTitled = deps.chatTitled;
    // Passed around as callbacks (onResolve, onControlTask, ...): keep `this`.
    this.submit = this.submit.bind(this);
    this.clearSubmitError = this.clearSubmitError.bind(this);
    this.invokeCommand = this.invokeCommand.bind(this);
    this.refresh = this.refresh.bind(this);
    this.manageQueue = this.manageQueue.bind(this);
    this.controlTask = this.controlTask.bind(this);
    this.rewind = this.rewind.bind(this);
    this.abort = this.abort.bind(this);
    this.resolveInteraction = this.resolveInteraction.bind(this);
    this.view = {
      get: () => this.#store?.getView() ?? NO_SESSION,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** The current view of the open session, read at call time (the store is the source of truth). */
  #currentView(): Term2SessionView {
    return this.#store?.getView() ?? NO_SESSION;
  }

  /** Closes the previous chat's store and creates this one's; opens its stream if started. */
  open(sessionId: string | null): void {
    if (sessionId === this.#sessionId) return;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#started) this.#store?.close();
    this.#sessionId = sessionId;
    this.#store = sessionId ? new Term2SessionStore(sessionId, { diagnostics: diagnosticsOn() }) : null;
    if (this.#store) {
      this.#unsubscribe = this.#store.subscribe(() => this.#notify());
      if (this.#started) this.#store.start();
    }
    this.#notify();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#store?.start();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#store?.close();
  }

  /** With diagnostics on, the last frames the session stream sent (for the diagnostics panel only). */
  frames(): readonly unknown[] | null {
    return this.#store?.frames ?? null;
  }

  clearSubmitError(): void {
    this.feedback.set((current) => (current.submitError ? { ...current, submitError: null } : current));
  }

  #setCommand(command: SessionFeedback['command']): void {
    this.feedback.set((current) => ({ ...current, command }));
  }

  #setPending(sessionId: string): void {
    this.feedback.set((current) => ({ ...current, commandPendingSessionId: sessionId }));
  }

  #clearPending(sessionId: string): void {
    this.feedback.set((current) =>
      current.commandPendingSessionId === sessionId ? { ...current, commandPendingSessionId: null } : current,
    );
  }

  async submit(text: string, options?: MessageSubmitOptions): Promise<boolean> {
    const id = this.#sessionId;
    const hasAttachments = Boolean(options?.attachments && options.attachments.length > 0);
    if (
      !id ||
      (!text.trim() && !hasAttachments) ||
      this.#currentView().sessionId !== id ||
      !canSubmitSessionMessage(this.#currentView().status) ||
      this.#currentView().pendingInteraction !== null ||
      this.#admitting.has(id)
    ) {
      return false;
    }
    const owner = this.#store;
    const sequenceAtSubmit = this.#currentView().lastAppliedSequence;
    const clientRequestId = crypto.randomUUID();
    this.#admitting.add(id);
    this.feedback.set((current) =>
      current.submitError?.sessionId === id ? { ...current, submitError: null } : current,
    );
    try {
      await term2Client.submitMessage(id, text, clientRequestId, options);
      if (owner !== this.#store || this.#sessionId !== id) return false;
      const firstLine = text.trim().split('\n')[0]?.trim().slice(0, 120);
      if (firstLine) this.#chatTitled(id, firstLine);
      // Until the accepted turn arrives, show the chat as running (the next accepted frame clears this).
      const now = this.#currentView();
      if (canSubmitSessionMessage(now.status) && now.lastAppliedSequence === sequenceAtSubmit)
        owner?.setOverlay({ status: 'running', error: null });
      return true;
    } catch (error) {
      if (owner !== this.#store || this.#sessionId !== id) return false;
      // Keep a healthy stream alive and the composer usable so the user can edit/retry immediately.
      this.feedback.set((current) => ({
        ...current,
        submitError: {
          sessionId: id,
          message: error instanceof Error ? error.message : 'Message was not accepted. Please try again.',
        },
      }));
      return false;
    } finally {
      this.#admitting.delete(id);
    }
  }

  // Command results never render a turn: an accepted retry arrives through the
  // session event stream, so only outcomes and failures need local state.
  async invokeCommand(commandId: Term2CommandId): Promise<void> {
    const id = this.#sessionId;
    if (!id) return;
    this.#setPending(id);
    this.#setCommand(null);
    try {
      const result = await term2Client.commands(id, commandId, crypto.randomUUID());
      if (result.outcome !== 'accepted') this.#setCommand({ sessionId: id, ...commandNoticeFor(commandId, result) });
    } catch (error) {
      const message =
        error instanceof Term2ApiError && error.code && error.code in COMMAND_ERROR_MESSAGES
          ? COMMAND_ERROR_MESSAGES[error.code]
          : error instanceof Error
          ? error.message
          : 'The command was not accepted';
      this.#setCommand({ sessionId: id, tone: 'error', message });
    } finally {
      this.#clearPending(id);
    }
  }

  /** Tears down the prior stream; the next snapshot frame is a fresh cut (never a second one over a live stream). */
  refresh(): void {
    this.#store?.refresh();
  }

  async manageQueue(action: QueueManageAction): Promise<boolean> {
    const id = this.#sessionId;
    if (!id) return false;
    try {
      await term2Client.manageQueue(id, action);
      return true;
    } catch (error) {
      this.#setCommand({
        sessionId: id,
        tone: 'error',
        message: error instanceof Error ? error.message : 'Queue action failed.',
      });
      return false;
    }
  }

  async controlTask(action: TaskControlAction): Promise<boolean> {
    const id = this.#sessionId;
    if (!id) return false;
    try {
      await term2Client.controlTask(id, action);
      return true;
    } catch (error) {
      this.#setCommand({
        sessionId: id,
        tone: 'error',
        message: error instanceof Error ? error.message : 'Task action failed.',
      });
      return false;
    }
  }

  /**
   * `forResend` is for Edit and Retry, which send right after: it skips the "Conversation rewound." notice and
   * resolves only once the reloaded chat accepts messages again.
   */
  async rewind(targetId: string, expectedRevision?: string, options?: { forResend?: boolean }): Promise<boolean> {
    const id = this.#sessionId;
    if (!id) return false;
    this.#setPending(id);
    this.#setCommand(null);
    try {
      await term2Client.rewindSession(id, {
        targetId,
        clientRequestId: crypto.randomUUID(),
        ...(expectedRevision ? { expectedRevision } : {}),
      });
      if (!options?.forResend) this.#setCommand({ sessionId: id, tone: 'neutral', message: 'Conversation rewound.' });
      this.refresh();
      if (!options?.forResend) return true;
      // The reload reconnects the event stream; a send before it is back would be refused.
      // UI wait only: on timeout the caller's send is refused and its text is kept.
      for (let waited = 0; waited < 10_000; waited += 50) {
        if (this.#sessionId !== id) return false;
        if (this.#currentView().sessionId === id && canSubmitSessionMessage(this.#currentView().status)) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return true;
    } catch (error) {
      this.#setCommand({
        sessionId: id,
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not rewind conversation.',
      });
      return false;
    } finally {
      this.#clearPending(id);
    }
  }

  async abort(): Promise<void> {
    const id = this.#sessionId;
    const owner = this.#store;
    const activeTurnId = this.#currentView().turns.find(
      (item) => item.status === 'streaming' || item.status === 'pending',
    )?.turnId;
    if (!id || !activeTurnId || !owner) return;
    owner.setOverlay({ status: 'aborting', error: null });
    try {
      await term2Client.abort(id, activeTurnId);
    } catch (error) {
      if (owner !== this.#store || this.#sessionId !== id) return;
      owner.setOverlay({ status: 'error', error: error instanceof Error ? error.message : 'Abort result unknown' });
    }
  }

  async resolveInteraction(request: InteractionResolveRequest): Promise<void> {
    const id = this.#sessionId;
    const owner = this.#store;
    const pending = this.#currentView().pendingInteraction;
    if (!id || !owner || pending?.state !== 'pending') return;
    const stillCurrent = () => {
      const current = this.#currentView().pendingInteraction;
      return (
        owner === this.#store &&
        this.#sessionId === id &&
        current?.state === 'pending' &&
        current.interaction.interactionId === request.interactionId &&
        current.interaction.revision === request.revision
      );
    };
    try {
      const result = await term2Client.resolveInteraction(id, request.interactionId, {
        revision: request.revision,
        answer: request.answer,
        ...(request.rejectionReason === undefined ? {} : { rejectionReason: request.rejectionReason }),
        ...(request.approvalAnswer === undefined ? {} : { approvalAnswer: request.approvalAnswer }),
      });
      if (!stillCurrent()) return;
      // A multi-question request answers with its next step: the same request, a new DTO.
      if (!result.accepted) owner.replaceInteractionById(request.interactionId, { ...pending, interaction: result.interaction });
    } catch (error) {
      if (!stillCurrent()) return;
      if (error instanceof Term2ApiError && [409, 410].includes(error.status)) {
        const message =
          error.code && error.code in INTERACTION_CONFLICT_MESSAGES
            ? INTERACTION_CONFLICT_MESSAGES[error.code as keyof typeof INTERACTION_CONFLICT_MESSAGES]
            : 'The interaction changed; the latest session state was reloaded.';
        this.refresh();
        if (owner === this.#store && this.#sessionId === id) owner.setOverlay({ error: message });
        return;
      }
      owner.setOverlay({ error: error instanceof Error ? error.message : 'Interaction was not accepted' });
    }
  }
}
