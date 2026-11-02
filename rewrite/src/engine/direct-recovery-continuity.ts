/** Live provider continuity. Session's durable history remains authoritative. */
import { isDeepStrictEqual } from 'node:util';
import type { Item, ModelRequest, ToolCallId } from '../model/index.js';

export type DirectContinuityBinding = {
  /** Session/run lineage, not a provider response id. New Session = new origin. */
  readonly origin: string;
  /** Canonical endpoint/account identity; never include credentials here. */
  readonly endpoint: string;
};
export type PreparedDirectRequest = {
  readonly ticket: number;
  readonly request: ModelRequest;
  readonly chained: boolean;
};

type PendingRequest = {
  ticket: number;
  binding: DirectContinuityBinding;
  canonical: ModelRequest;
};
type Checkpoint = {
  binding: DirectContinuityBinding;
  envelope: Omit<ModelRequest, 'input'>;
  history: readonly Item[];
  continuation?: unknown;
  previousResponseId?: string;
  debt: readonly ToolCallId[];
};

/**
 * Keep one accepted checkpoint, never a second mutable conversation. Prepare
 * from full canonical history; only an exact prefix with the same request
 * envelope may become a delta. Accept only after Session commits the terminal
 * response. Clearing invalidates outstanding tickets, including late responses.
 * This class neither persists opaque state nor guesses response ids from it.
 */
export class DirectContinuity {
  #checkpoint: Checkpoint | undefined;
  #pending: PendingRequest | undefined;
  #ticket = 0;
  #broken = false;

  /** Full input in, provider-ready input out. New user turns cannot inherit tool debt. */
  prepare(canonical: ModelRequest, binding: DirectContinuityBinding, newTurn = false): PreparedDirectRequest {
    const selected = this.preview(canonical, binding, newTurn);
    if (!selected.chained) this.#checkpoint = undefined;
    const ticket = ++this.#ticket;
    this.#pending = { ticket, binding: structuredClone(binding), canonical: structuredClone(canonical) };
    return { ticket, ...selected };
  }

  /** Select the exact provider-ready input without changing checkpoints, tickets or pending requests. */
  preview(
    canonical: ModelRequest,
    binding: DirectContinuityBinding,
    newTurn = false,
  ): Omit<PreparedDirectRequest, 'ticket'> {
    const checkpoint = this.#checkpoint;
    const canChain =
      !this.#broken &&
      !canonical.disableChaining &&
      !!checkpoint &&
      isDeepStrictEqual(binding, checkpoint.binding) &&
      isDeepStrictEqual(envelope(canonical), checkpoint.envelope) &&
      hasPrefix(canonical.input, checkpoint.history) &&
      !(newTurn && checkpoint.debt.length > 0) &&
      paysToolDebt(canonical.input.slice(checkpoint.history.length), checkpoint.debt);
    return {
      chained: canChain,
      request:
        canChain && checkpoint
          ? {
              ...canonical,
              input: canonical.input.slice(checkpoint.history.length),
              disableChaining: false,
              ...(checkpoint.continuation !== undefined ? { continuation: checkpoint.continuation } : {}),
              ...(checkpoint.previousResponseId ? { previousResponseId: checkpoint.previousResponseId } : {}),
            }
          : selfContained(canonical),
    };
  }

  /** Promote accepted provider state; partial/cancelled/uncommitted responses must never call this. */
  accept(input: {
    readonly ticket: number;
    readonly history: readonly Item[];
    readonly continuation?: unknown;
    readonly previousResponseId?: string;
  }): boolean {
    const pending = this.#pending;
    if (!pending || pending.ticket !== input.ticket) return false;
    this.#pending = undefined;
    if (
      this.#broken ||
      !hasPrefix(input.history, pending.canonical.input) ||
      (input.continuation == null && !input.previousResponseId)
    ) {
      this.#checkpoint = undefined;
      return false;
    }
    try {
      this.#checkpoint = {
        binding: pending.binding,
        envelope: envelope(pending.canonical),
        history: structuredClone(input.history),
        ...(input.continuation != null ? { continuation: structuredClone(input.continuation) } : {}),
        ...(input.previousResponseId ? { previousResponseId: input.previousResponseId } : {}),
        debt: outstandingToolDebt(input.history),
      };
      return true;
    } catch {
      // Continuity is an optimization: uncloneable opaque state must not turn
      // an already-accepted response/effect into a replayable model failure.
      this.#checkpoint = undefined;
      return false;
    }
  }

  /** Reconcile known request-only decorations after the accepted turn is durably committed. */
  reconcilePrefix(sent: readonly Item[], durable: readonly Item[]): void {
    const checkpoint = this.#checkpoint;
    if (!checkpoint || sent.length !== durable.length || !hasPrefix(checkpoint.history, sent)) return;
    if (sent.some((item, index) => item.id !== durable[index]?.id || item.type !== durable[index]?.type)) return;
    this.#checkpoint = {
      ...checkpoint,
      history: [...structuredClone(durable), ...checkpoint.history.slice(sent.length)],
    };
  }

  /** Retry, rewind, compaction, rollover, model/endpoint change and cancellation retire the checkpoint. */
  clear(): void {
    this.#checkpoint = undefined;
    this.#pending = undefined;
    this.#ticket++;
  }

  /** A transport downgrade may disable chaining for the lifetime of this run. */
  breakChaining(): void {
    this.clear();
    this.#broken = true;
  }
}

function envelope(request: ModelRequest): Omit<ModelRequest, 'input'> {
  const {
    input: _input,
    continuation: _continuation,
    previousResponseId: _response,
    disableChaining: _disable,
    ...rest
  } = request;
  return rest;
}

/** Explicitly suppress even adapter-local response-id caches on a full-history request. */
export function selfContained(request: ModelRequest): ModelRequest {
  const { continuation: _continuation, previousResponseId: _response, ...rest } = request;
  return { ...rest, previousResponseId: null, disableChaining: true };
}

function hasPrefix(history: readonly Item[], prefix: readonly Item[]): boolean {
  return history.length >= prefix.length && prefix.every((item, index) => isDeepStrictEqual(item, history[index]));
}

/** Count occurrences, not unique provider call ids: providers can reuse an id. */
function outstandingToolDebt(history: readonly Item[]): ToolCallId[] {
  const pending: ToolCallId[] = [];
  for (const item of history) {
    if (item.type === 'tool_call') pending.push(item.callId);
    if (item.type === 'tool_result') {
      const index = pending.indexOf(item.callId);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  return pending;
}

function paysToolDebt(delta: readonly Item[], debt: readonly ToolCallId[]): boolean {
  const remaining = [...debt];
  for (const item of delta) {
    if (remaining.length && item.type === 'user_message') return false;
    if (item.type !== 'tool_result') continue;
    const index = remaining.indexOf(item.callId);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining.length === 0;
}
