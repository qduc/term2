/** Direct wire-backed control port. Owns a single read attachment, never the
 * conversation, engine, durable admission policy or runtime completion loop.
 */
import type { WireCommandResult, WireSnapshot } from '../../protocol/wire.js';
import { reduceWireEvent } from '../../protocol/reducer.js';
import type { BridgeInput, BridgeOutcome, ControlMutationReceipt, ControlTopic } from './transport.js';
import type { ControlSubmission, DirectControlPortOptions, DirectControlSessionPort } from './types.js';
import { ControlCompletions, type ControlDelivery } from './completions.js';
import { controlGet, controlStatus } from './read-model.js';
import { bridgeText } from './bridge-input.js';
import { admissionReceipt, bridgeSubmissionResult } from './submission-result.js';
import type { ControlBridgeResult } from './transport.js';

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
  const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
  if (admission.kind === 'rejected' && admission.reason === 'request_conflict')
    throw Object.assign(new Error('clientRequestId was already used with a different body'), { code: 'conflict' });
  return admissionReceipt(result.admission);
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
    return this.#mutate(
      {
        requestId: params.clientRequestId,
        text: bridgeText(params),
        origin: {
          kind: 'discord',
          source: params.origin.kind === 'human' && params.origin.relayedBy ? 'agent' : params.origin.kind,
          sender: params.origin.sender,
          ...(params.origin.kind === 'human' && params.origin.discordMessageId !== undefined
            ? { discordMessageId: params.origin.discordMessageId }
            : {}),
          ...(params.origin.kind === 'human' && params.origin.relayedBy !== undefined
            ? { relayedBy: params.origin.relayedBy }
            : {}),
        },
      },
      params.origin.kind === 'human' && !params.origin.relayedBy ? 'steer' : 'follow_up',
      { complete },
    );
  }

  bridgeResult(params: { readonly sessionId: string; readonly clientRequestId: string }): ControlBridgeResult {
    this.#requireAttached();
    if (params.sessionId !== this.#state.sessionId) return { state: 'missing' };
    return bridgeSubmissionResult(this.#state, params.clientRequestId);
  }

  async interrupt(): Promise<{ accepted: boolean; reason?: string }> {
    if (this.#isClosed) return { accepted: false, reason: 'closed' };
    const state = this.#state;
    if (state.status === 'closed') return { accepted: false, reason: 'closed' };
    const foreground =
      state.activeTurnId !== null || state.status === 'running' || state.status === 'awaiting_interaction';
    const interaction = !foreground ? state.pendingInteractions[0] : undefined;
    const candidates = interaction
      ? state.tasks.filter((task) =>
          interaction.taskId
            ? task.id === interaction.taskId
            : task.turnId === interaction.turnId &&
              (task.status === 'running' || task.status === 'awaiting_interaction'),
        )
      : [];
    // A shared parent turn alone is not enough when several background tasks exist.
    const background = candidates.length === 1 ? candidates[0] : undefined;
    const manualQueuePause = state.queueState === 'paused' && state.queuePauseReason === 'manual';
    if (!foreground && !background && (!manualQueuePause || interaction !== undefined)) {
      const outstanding = state.pendingInteractions.length > 0 || state.queue.length > 0 || state.queueState !== 'idle';
      // Failure/recovery pauses require explicit queue action, not a stop that
      // pretends to discard queued work. Unknown background ownership stays unavailable.
      return { accepted: false, reason: outstanding ? 'unavailable' : 'idle' };
    }
    // Untargeted foreground stop preserves Session's queue semantics, including
    // a second stop resuming the retained manual pause.
    const target = background ? { kind: 'task' as const, id: background.id } : undefined;
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
        origin: { kind: 'control', ...(params.origin !== undefined ? { source: 'orchestrator' } : {}) },
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
    const known = this.#state.submissions?.some((record) => record.clientRequestId === submission.requestId);
    if (!known) {
      const preview = await this.#options.connection.send({
        type: 'preview',
        text: submission.text,
        ...(submission.attachments !== undefined ? { attachments: submission.attachments } : {}),
      });
      if (!preview.ok) return rejected(preview.code);
      if (preview.kind !== 'preview') return rejected('invalid_preview_response');
      if (preview.requiresConfirmation) return rejected('needs_confirmation');
    }
    if (this.#isClosed) return rejected('closed');
    // Known IDs still go through real Session fingerprint/write authorization.
    // Re-previewing a retry would gate its original receipt on edited/current input.
    // The preview may await Session while another client opens an interaction.
    if (
      !known &&
      callbacks.complete &&
      (this.#state.pendingInteractions.length > 0 || (this.#state.pendingBudgets?.length ?? 0) > 0)
    )
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
