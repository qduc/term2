/** Direct wire-backed control port. Owns a single read attachment, never the
 * conversation, engine, durable admission policy or runtime completion loop.
 */
import type { WireCommandResult, WireSnapshot } from '../../protocol/direct-wire.js';
import { reduceWireEvent } from '../../protocol/direct-reducer.js';
import type { BridgeInput, BridgeOutcome, ControlMutationReceipt, ControlTopic } from './transport.js';
import type { ControlSubmission, DirectControlPortOptions, DirectControlSessionPort } from './types.js';
import { ControlCompletions, type ControlDelivery } from './completions.js';
import { controlGet, controlStatus } from './read-model.js';
import { bridgeText } from './bridge-input.js';

type Mutation = { text: string; clientRequestId: string; origin?: unknown; onSteerSettled?: () => void };
const rejected = (reason: string): ControlMutationReceipt => ({ delivery: 'rejected', reason });

function receipt(result: WireCommandResult): ControlMutationReceipt {
  if (!result.ok) {
    if (result.code === 'request_conflict') {
      throw Object.assign(new Error(result.message), { code: 'conflict' });
    }
    return rejected(result.code);
  }
  if (result.kind !== 'admitted') throw new Error('Control submission did not return an admission');
  const replayed = result.admission.kind === 'duplicate';
  const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
  if (admission.kind === 'rejected') return { ...rejected(admission.reason), ...(replayed ? { replayed: true } : {}) };
  return { messageId: admission.messageId, delivery: admission.kind, ...(replayed ? { replayed: true } : {}) };
}

class DirectControlPort implements DirectControlSessionPort {
  readonly #options: DirectControlPortOptions;
  readonly #completions = new ControlCompletions();
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  #state: WireSnapshot;
  #isClosed = false;
  #failure: unknown;

  constructor(options: DirectControlPortOptions) {
    if (options.connection.snapshot.sessionId !== options.connection.sessionId) {
      throw new Error('Control connection snapshot belongs to a different session');
    }
    this.#options = options;
    this.#state = options.connection.snapshot;
    let resolveClosed!: () => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    void this.#consume();
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }
  get failure(): unknown {
    return this.#failure;
  }

  status(): unknown {
    this.#requireAttached();
    return controlStatus(this.#state, this.#options);
  }

  get(topic: ControlTopic): unknown {
    this.#requireAttached();
    return controlGet(this.#state, topic, this.#options);
  }

  submit(params: Mutation): Promise<ControlMutationReceipt> {
    return this.#controlMutation(params, 'follow_up');
  }

  steer(params: Mutation): Promise<ControlMutationReceipt> {
    return this.#controlMutation(params, 'steer');
  }

  async bridgeSubmit(params: BridgeInput, complete: (outcome: BridgeOutcome) => void): Promise<ControlMutationReceipt> {
    if (this.#isClosed) return rejected('closed');
    if (params.sessionId !== this.#options.connection.sessionId) return rejected('session_identity_changed');
    if (this.#state.pendingInteractions.length > 0) return rejected('terminal_interaction_required');
    if (!this.#options.bridgeOrigin) return rejected('unavailable');
    return this.#mutate(
      {
        requestId: params.clientRequestId,
        text: bridgeText(params),
        origin: this.#options.bridgeOrigin(params.origin),
      },
      params.origin.kind === 'human' ? 'steer' : 'follow_up',
      { complete },
    );
  }

  async interrupt(): Promise<{ accepted: boolean; reason?: string }> {
    if (this.#isClosed) return { accepted: false, reason: 'closed' };
    const state = this.#state;
    if (state.status === 'closed') return { accepted: false, reason: 'closed' };
    const foreground =
      state.activeTurnId !== null || state.status === 'running' || state.status === 'awaiting_interaction';
    const background =
      !foreground && state.pendingInteractions.length > 0
        ? state.tasks.find((task) => task.turnId === state.pendingInteractions[0]?.turnId)
        : undefined;
    if (!foreground && !background) {
      const outstanding = state.pendingInteractions.length > 0 || state.queue.length > 0 || state.queueState !== 'idle';
      // A foreground cancel cannot truthfully acknowledge queue-only cancellation
      // or a background interaction whose owning task isn't in the public model.
      return { accepted: false, reason: outstanding ? 'unavailable' : 'idle' };
    }
    const target = background ? { kind: 'task' as const, id: background.id } : { kind: 'foreground' as const };
    const result = await this.#options.connection.send({ type: 'cancel', target });
    if (!result.ok) return { accepted: false, reason: result.code };
    if (result.kind !== 'accepted') return { accepted: false, reason: 'invalid_cancel_response' };
    return { accepted: true };
  }

  close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    try {
      this.#options.connection.close();
    } catch (error) {
      this.#failure ??= error;
    } finally {
      this.#completions.close();
      this.#resolveClosed();
    }
  }

  async #controlMutation(params: Mutation, mode: 'follow_up' | 'steer'): Promise<ControlMutationReceipt> {
    if (!params.text.trim() || !/^[A-Za-z0-9_-]{1,256}$/.test(params.clientRequestId))
      return rejected('invalid_request');
    // The v1 socket permits only orchestrator input; peer remains explicitly unavailable.
    if (params.origin !== undefined) {
      if (!params.origin || typeof params.origin !== 'object' || Array.isArray(params.origin))
        return rejected('invalid_origin');
      const origin = params.origin as Record<string, unknown>;
      if (origin.kind === 'peer') return rejected('unavailable');
      if (origin.kind !== 'orchestrator' || Object.keys(origin).some((key) => key !== 'kind'))
        return rejected('invalid_origin');
    }
    return this.#mutate(
      {
        requestId: params.clientRequestId,
        text: params.text,
        origin: { kind: 'control', ...(params.origin !== undefined ? { id: JSON.stringify(params.origin) } : {}) },
      },
      mode,
      { onSteerSettled: params.onSteerSettled },
    );
  }

  async #mutate(
    submission: ControlSubmission,
    mode: 'follow_up' | 'steer',
    callbacks: Pick<ControlDelivery, 'complete' | 'onSteerSettled'>,
  ): Promise<ControlMutationReceipt> {
    if (this.#isClosed) return rejected('closed');
    const preview = await this.#options.connection.send({
      type: 'preview',
      text: submission.text,
      ...(submission.attachments !== undefined ? { attachments: submission.attachments } : {}),
    });
    if (!preview.ok) return rejected(preview.code);
    if (preview.kind !== 'preview') return rejected('invalid_preview_response');
    if (preview.requiresConfirmation) return rejected('needs_confirmation');
    if (this.#isClosed) return rejected('closed');
    // The preview awaits Session: another client may have opened an interaction meanwhile.
    if (callbacks.complete && this.#state.pendingInteractions.length > 0)
      return rejected('terminal_interaction_required');
    const delivery = this.#completions.register(callbacks);
    try {
      const result = await this.#options.connection.send({ type: 'submit', ...submission, delivery: mode });
      const mutation = receipt(result);
      if (result.ok && result.kind === 'admitted') {
        const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
        if (admission.kind === 'rejected') this.#completions.reject(delivery);
        else this.#completions.admit(delivery, admission, result.admission.kind === 'duplicate', this.#state);
      } else this.#completions.reject(delivery);
      return mutation;
    } catch (error) {
      // Admission may already be durable. Do not manufacture a not-admitted receipt
      // or resubmit; the socket owns uncertain-admission retention for bridge jobs.
      this.#completions.uncertain(delivery);
      throw error;
    }
  }

  #requireAttached(): void {
    if (this.#isClosed) throw new Error('Direct control attachment is closed');
  }

  async #consume(): Promise<void> {
    try {
      for await (const event of this.#options.connection.events) {
        if (this.#isClosed) break;
        if (event.sessionId !== this.#state.sessionId) throw new Error('Control received a cross-session event');
        this.#state = reduceWireEvent(this.#state, event);
        this.#completions.observe(event, this.#state);
      }
    } catch (error) {
      this.#failure = error;
    } finally {
      this.close();
    }
  }
}

/** Attach v1 control behavior to a dedicated direct connection. Consumes events
 * immediately and exposes detach/failure explicitly; app retains Host ownership.
 */
export function createDirectControlSessionPort(options: DirectControlPortOptions): DirectControlSessionPort {
  return new DirectControlPort(options);
}
