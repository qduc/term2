/** Live host facade over one direct Conversation. Only that Conversation writes facts. */
import { randomUUID } from 'node:crypto';
import type { InteractionDecision, InteractionRequestId, TurnId } from '../engine/index.js';
import type { Item, ItemId, ModelError, ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { Conversation, Turn, TurnRequest } from './direct-types.js';
import type {
  DirectAdmission,
  DirectCancelTarget,
  DirectSession,
  DirectSessionCapture,
  DirectSessionReplayCapture,
  DirectSessionUpdate,
  DirectSubmission,
} from './facade-types.js';
import type { Fact } from './facts.js';
import type { ConversationLog } from './log.js';
import {
  initialDirectState,
  interruptedDirectState,
  reduceDirectFact,
  directSubmittedTurn,
  type DirectPublicState,
} from './direct-state.js';

type DirectDurableUpdate = Extract<DirectSessionUpdate, { readonly type: 'fact' }>;
export type DirectLiveCapture = Omit<DirectSessionCapture, 'state'> & {
  readonly state: DirectPublicState;
  /** Real accepted-log cursor at the same cut as state, not publication position. */
  readonly seq: number;
};
export type DirectCatchUp = DirectSessionReplayCapture & { readonly state: DirectPublicState };
export interface DirectLiveSession extends DirectSession {
  capture(listener: (update: DirectSessionUpdate) => void): DirectLiveCapture;
  /** Durable catch-up then live updates. State is the final cut, never a snapshot to prepend to replay.
   * Reopened-interruption and other live-only state must be synchronized from that final state.
   */
  captureFrom(fromSeq: number, listener: (update: DirectSessionUpdate) => void): DirectCatchUp;
}
export type DirectSessionOptions = {
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly log: ConversationLog;
  readonly facts: readonly Fact[];
  readonly request: Omit<TurnRequest, 'input' | 'model' | 'submission'>;
  /** Constructs the real direct conversation with this observing log, never another writer. */
  readonly attach: (log: ConversationLog) => Conversation;
  readonly dispose?: () => void | Promise<void>;
  readonly released?: () => void;
};

type Subscriber = { readonly after: number; readonly listener: (update: DirectSessionUpdate) => void };
type Active = { readonly turn: Turn; readonly done: Promise<void> };
type Remembered = {
  readonly body: string;
  readonly admission: Exclude<DirectAdmission, { readonly kind: 'duplicate' }>;
};

/**
 * Owns one semantic-stream drain, admission exclusion and an atomic publication cut.
 * The observing log delegates every append before updating state; it never appends on its own.
 * Accepted turn_started submission metadata rebuilds admissions and duplicate/conflict identity on open.
 */
export function createDirectSession(options: DirectSessionOptions): DirectLiveSession {
  let state = initialDirectState(options.id, options.workspace, options.model);
  const durable: DirectDurableUpdate[] = [];
  let position = 0;
  let seq = 0;
  let active: Active | null = null;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  let fault: ModelError | null = null;
  const subscribers = new Set<Subscriber>();
  const pending: DirectSessionUpdate[] = [];
  const remembered = new Map<string, Remembered>();
  let scheduled = false;

  const rememberSubmission = (fact: Fact): void => {
    if (fact.type !== 'turn_started') return;
    const submitted = directSubmittedTurn(fact);
    if (!submitted) return;
    const key = submitted.request.clientRequestId;
    if (remembered.has(key)) throw new Error(`duplicate durable direct submission ID ${key}`);
    remembered.set(key, { body: submissionBody(submitted.request), admission: submitted.admission });
  };

  // Replayed entries get positions in this runtime's projection order; these
  // are not historical ordinals from the process that originally wrote them.
  for (const fact of options.facts) {
    rememberSubmission(fact);
    state = reduceDirectFact(state, fact);
    durable.push({ type: 'fact', position: ++position, seq: ++seq, fact });
  }
  state = interruptedDirectState(state);

  // Deferring delivery until append returns keeps callbacks outside the writer's
  // acceptance stack. Capture can still see the new state/cursor synchronously.
  const publish = (update: DirectSessionUpdate): void => {
    pending.push(update);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      try {
        while (pending.length) {
          const next = pending.shift()!;
          for (const subscriber of [...subscribers]) {
            if (!subscribers.has(subscriber) || next.position <= subscriber.after) continue;
            try {
              subscriber.listener(structuredClone(next));
            } catch {
              // A failed observer is detached, never allowed to poison accepted work
              // or prevent another connection from receiving the same ordered update.
              subscribers.delete(subscriber);
            }
          }
        }
      } finally {
        scheduled = false;
      }
    });
  };
  const publishState = (): void => publish({ type: 'state', position: ++position, state });
  const observe = (facts: readonly Fact[]): void => {
    for (const fact of facts) {
      rememberSubmission(fact);
      state = reduceDirectFact(state, fact);
      const update: DirectDurableUpdate = { type: 'fact', position: ++position, seq: ++seq, fact };
      durable.push(update);
      publish(update);
    }
  };
  const observedLog: ConversationLog = {
    path: options.log.path,
    append(facts) {
      // Detach accepted payloads from tool/provider-owned objects, using the same
      // JSON representation the sole writer persists. No fact type is fabricated.
      const accepted = JSON.parse(JSON.stringify(facts)) as Fact[];
      options.log.append(accepted);
      observe(accepted);
    },
    close: () => options.log.close(),
  };
  const conversation = options.attach(observedLog);

  const recordFault = (error: unknown): void => {
    fault = { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
    state = { ...interruptedDirectState(state), status: 'interrupted', runtimeError: fault };
    publishState();
  };
  const drain = async (turn: Turn, admittedTurnId: TurnId | null): Promise<void> => {
    try {
      let terminal = false;
      for await (const event of turn.events) {
        if (event.type === 'reasoning_delta' || event.type === 'tool_progress') {
          if (event.type === 'reasoning_delta') state = { ...state, reasoning: state.reasoning + event.delta };
          publish({ type: 'transient', position: ++position, event });
        }
        if (event.type === 'turn_ended') {
          terminal = true;
          // A poisoned writer's failed terminal is semantic only, never a fake fact.
          if (
            event.result.kind === 'failed' &&
            (!admittedTurnId || state.terminal?.turnId !== admittedTurnId || state.terminal.outcome !== 'failed')
          ) {
            recordFault(event.result.error.message);
          }
        }
      }
      if (!terminal) throw new Error(`conversation ${options.id} ended without a terminal event`);
      active = null; // iteration completion, not cancel() or terminal delivery, releases admission
      publishState();
    } catch (error) {
      turn.cancel();
      recordFault(error);
      // Keep admission/close ownership: cleanup was not proved by this broken stream.
      throw error;
    }
  };
  const startDrain = (turn: Turn, admittedTurnId: TurnId | null): void => {
    const done = Promise.resolve().then(() => drain(turn, admittedTurnId));
    active = { turn, done };
    // close() still observes this rejection. Avoid an unhandled rejection while
    // the owner is waiting for a client to request shutdown.
    void done.catch(() => {});
  };
  const capture = (listener: Subscriber['listener']): DirectLiveCapture => {
    const subscriber = { after: position, listener };
    const snapshot = structuredClone(state);
    subscribers.add(subscriber);
    return {
      state: snapshot,
      position,
      seq,
      unsubscribe: () => {
        subscribers.delete(subscriber);
      },
    };
  };

  return {
    id: options.id,
    async submit(request) {
      const invalid = validateSubmission(request);
      if (invalid) return { kind: 'rejected', clientRequestId: request.clientRequestId, reason: invalid };
      const normalized = structuredClone(request);
      const body = submissionBody(normalized);
      const previous = remembered.get(normalized.clientRequestId);
      if (previous) {
        return previous.body === body
          ? {
              kind: 'duplicate',
              clientRequestId: normalized.clientRequestId,
              original: structuredClone(previous.admission),
            }
          : {
              kind: 'rejected',
              clientRequestId: normalized.clientRequestId,
              reason: 'client request ID conflicts with an earlier submission',
            };
      }
      if (closing || fault || active)
        return {
          kind: 'rejected',
          clientRequestId: normalized.clientRequestId,
          reason: closing
            ? 'session is closed'
            : fault
            ? fault.message
            : 'session is busy; queue and steering are not available',
        };
      const messageId = randomUUID();
      const input: Item = { type: 'user_message', id: messageId as ItemId, content: normalized.content };
      const before = seq;
      let turn: Turn;
      try {
        turn = conversation.run({
          ...options.request,
          model: options.model,
          input: [input],
          submission: {
            clientRequestId: normalized.clientRequestId,
            messageId,
            ...(normalized.origin ? { origin: normalized.origin } : {}),
          },
        });
      } catch (error) {
        recordFault(error);
        return { kind: 'rejected', clientRequestId: normalized.clientRequestId, reason: fault!.message };
      }
      const started = durable.slice(before).find((update) => update.fact.type === 'turn_started');
      // Match failure settlement to this admission, never a previous failed turn.
      startDrain(turn, started?.fact.type === 'turn_started' ? started.fact.turnId : null);
      const original = remembered.get(normalized.clientRequestId);
      if (
        started?.fact.type !== 'turn_started' ||
        !original ||
        started.fact.submission?.clientRequestId !== normalized.clientRequestId ||
        started.fact.submission.messageId !== messageId
      )
        return {
          kind: 'rejected',
          clientRequestId: normalized.clientRequestId,
          reason: 'conversation did not durably accept the correlated input',
        };
      const admission = structuredClone(original.admission);
      publishState();
      return admission;
    },
    answer(requestId: InteractionRequestId, decision: InteractionDecision) {
      if (closing || fault || !active || !state.pendingInteractions.some((request) => request.requestId === requestId))
        return { kind: 'stale' };
      return active.turn.answer(requestId, structuredClone(decision));
    },
    cancel(target?: DirectCancelTarget) {
      if (target?.kind === 'task')
        throw new Error('background task cancellation is not available on the M2 conversation');
      active?.turn.cancel();
    },
    capture,
    captureFrom(fromSeq, listener) {
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || fromSeq > seq)
        throw new Error(`invalid direct log cursor ${fromSeq}`);
      // No await or callbacks between this replay cut and capture's registration.
      const replay = structuredClone(durable.slice(fromSeq));
      return { ...capture(listener), replay };
    },
    close() {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = (async () => {
        active?.turn.cancel();
        if (active) await active.done;
        try {
          await conversation.close();
        } finally {
          await options.dispose?.();
          state = { ...state, status: 'closed', pendingInteractions: [], activeTurnId: null };
          publishState();
          queueMicrotask(() => subscribers.clear());
          options.released?.();
        }
      })();
      return closingPromise;
    },
  };
}

function validateSubmission(request: DirectSubmission): string | null {
  if (typeof request.clientRequestId !== 'string' || !request.clientRequestId.trim())
    return 'clientRequestId must not be empty';
  if (!Array.isArray(request.content) || !request.content.length) return 'content must not be empty';
  for (const part of request.content) {
    if (!part || typeof part !== 'object') return 'unsupported content part';
    if (part.type === 'text' && typeof part.text === 'string') continue;
    if (part.type === 'image' && typeof part.mediaType === 'string' && typeof part.data === 'string') continue;
    return 'unsupported content part';
  }
  if (!request.content.some((part) => part.type === 'image' || (part.type === 'text' && part.text.trim())))
    return 'content must not be blank';
  return null;
}

function submissionBody(request: DirectSubmission): string {
  // Stable field order, without trimming or otherwise altering provider-visible input.
  return JSON.stringify({
    content: request.content.map((part) =>
      part.type === 'text'
        ? { type: part.type, text: part.text }
        : {
            type: part.type,
            mediaType: part.mediaType,
            data: part.data,
            ...(part.detail !== undefined ? { detail: part.detail } : {}),
          },
    ),
    ...(request.origin
      ? { origin: { kind: request.origin.kind, ...(request.origin.id !== undefined ? { id: request.origin.id } : {}) } }
      : {}),
  });
}
