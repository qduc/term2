/** Live host facade over one direct Conversation. Only that Conversation writes facts. */
import { randomUUID } from 'node:crypto';
import { directPreviewLifecycle } from './direct-preview.js';
import type { Item, ItemId } from '../model/index.js';
import type { InteractionDecision, InteractionRequestId, TurnId } from '../engine/index.js';
import type { ModelError, ModelRef } from '../model/index.js';
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
import type { Fact, FactLine } from './facts.js';
import type { ConversationLog } from './log.js';
import {
  initialDirectState,
  interruptedDirectState,
  reduceDirectFact,
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
  readonly entries: readonly FactLine[];
  readonly request: Omit<TurnRequest, 'input' | 'model' | 'submission'>;
  /** Constructs the real direct conversation with this observing log, never another writer. */
  readonly attach: (
    log: ConversationLog,
    publish: (event: Extract<DirectSessionUpdate, { type: 'transient' }>['event']) => void,
  ) => Conversation;
  readonly dispose?: () => void | Promise<void>;
  readonly released?: () => void;
};

type Subscriber = { readonly after: number; readonly listener: (update: DirectSessionUpdate) => void };
type Active = { readonly turn: Turn; readonly done: Promise<void> };

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
  let scheduled = false;

  // Replayed entries get positions in this runtime's projection order; these
  // are not historical ordinals from the process that originally wrote them.
  for (const entry of options.entries) {
    state = reduceDirectFact(state, entry.fact, entry.seq);
    seq = entry.seq;
    durable.push({ type: 'fact', position: ++position, seq: entry.seq, at: entry.at, fact: entry.fact });
  }
  const resumedAtSeq = seq;
  let reopened = true;
  const publicState = () => (reopened ? interruptedDirectState(state) : state);

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
  const publishState = (): void => publish({ type: 'state', position: ++position, state: publicState() });
  const observedLog: ConversationLog = {
    path: options.log.path,
    append(facts) {
      const accepted = JSON.parse(JSON.stringify(facts)) as Fact[];
      // Invalid projections fail before disk mutation; install/publication happen
      // only after the sole underlying writer has accepted the complete batch.
      let candidate = state;
      for (const [index, fact] of accepted.entries()) candidate = reduceDirectFact(candidate, fact, seq + index + 1);
      const lines = options.log.append(accepted);
      state = candidate;
      reopened = false;
      for (const line of lines) {
        seq = line.seq;
        const update: DirectDurableUpdate = {
          type: 'fact',
          position: ++position,
          seq: line.seq,
          at: line.at,
          fact: line.fact,
        };
        durable.push(update);
        publish(update);
      }
      return lines;
    },
    close: () => options.log.close(),
  };
  const conversation = options.attach(observedLog, (event) =>
    publish({ type: 'transient', position: ++position, event }),
  );

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
      active = null; // actual iterator completion is the Session completion barrier
      if (admittedTurnId && !closing && !fault) {
        const outcome = state.terminal?.turnId === admittedTurnId ? state.terminal.outcome : 'interrupted';
        conversation.queue({ kind: 'settled', turnId: admittedTurnId, outcome });
      }
      publishState();
      if (!closing && !fault) advance();
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
    const snapshot = structuredClone(publicState());
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

  const advance = (): void => {
    if (active || closing || fault) return;
    const started = conversation.advanceQueue({ ...options.request, model: options.model });
    if (started) startDrain(started.turn, started.turnId);
  };
  const submit = async (request: import('./direct-queue-types.js').DirectQueueSubmission): Promise<DirectAdmission> => {
    const invalid = validateSubmission(request);
    if (invalid) return { kind: 'rejected', clientRequestId: request.clientRequestId, reason: invalid };
    if (closing || fault)
      return {
        kind: 'rejected',
        clientRequestId: request.clientRequestId,
        reason: fault?.message ?? 'session is closed',
      };
    try {
      const result = conversation.submit(structuredClone(request), { ...options.request, model: options.model });
      if (result.started) startDrain(result.started.turn, result.started.turnId);
      publishState();
      return structuredClone(result.admission);
    } catch (error) {
      recordFault(error);
      return { kind: 'rejected', clientRequestId: request.clientRequestId, reason: fault!.message };
    }
  };
  const mutate = async (command: import('./direct-queue-types.js').DirectQueueCommand) => {
    if (closing || fault) return { kind: 'rejected' as const, reason: 'invalid' as const };
    const result = conversation.queue(command);
    advance();
    return result;
  };
  return {
    id: options.id,
    snapshotInputPreview(request) {
      if (closing || fault) throw new Error(fault?.message ?? 'Session is closed');
      const content = [{ type: 'text' as const, text: request.text }, ...(request.attachments ?? [])];
      const invalid = validateSubmission({ clientRequestId: 'preview', content });
      if (invalid) throw new Error(invalid);
      const draft: Item = { type: 'user_message', id: randomUUID() as ItemId, content };
      const planned = conversation.snapshotInputPreview({ ...options.request, model: options.model, input: [draft] });
      return structuredClone({ ...planned, ...directPreviewLifecycle(durable, resumedAtSeq) });
    },
    submit,
    submitWithDelivery: submit,
    editQueue: (messageId, edit) => mutate({ kind: 'edit', messageId, edit }),
    retractQueue: (messageId) => mutate({ kind: 'retract', messageId }),
    resumeQueue: () => mutate({ kind: 'resume' }),
    discardQueue: () => mutate({ kind: 'discard' }),
    abort: (expectedTurnId, discardQueue) => conversation.abort(expectedTurnId, discardQueue),
    answerBudget: (requestId, decision, provenance) => conversation.answerBudget(requestId, decision, provenance),
    setGoal: (generation, goal, source) => conversation.setGoal(generation, goal, source),
    answer(requestId, decision, provenance) {
      if (closing || fault) return { kind: 'stale' };
      return conversation.answer(requestId, structuredClone(decision), provenance);
    },
    cancel(target?: DirectCancelTarget) {
      if (target?.kind === 'task') {
        conversation.tasks.requestStop(target.id);
        return;
      }
      conversation.queue({ kind: 'cancel', ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}) });
      if (!state.queue.active) active?.turn.cancel();
      advance();
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
        // A budget check-in is a settled request boundary, not a parked run.
        // Stop it durably and let the engine accept its interrupted terminal;
        // cancellation here would instead mislabel the budget stop as cancelled.
        const budgetWaits = publicState().pendingBudgets;
        let stoppingBudget = false;
        if (!fault && active) {
          for (const wait of budgetWaits) {
            const answer = conversation.answerBudget(wait.requestId, { kind: 'stop' }, { source: 'system' });
            stoppingBudget ||= answer.kind === 'accepted';
          }
        }
        if (!stoppingBudget) active?.turn.cancel();
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
