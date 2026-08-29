import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type {
  PendingInteractionResolution,
  ResolvePendingInteractionRequest,
} from '../services/session/pending-interaction-state.js';
import type { UserTurn } from '../types/user-turn.js';
import type { GatewaySessionComposition, SecretFreeWorkerSettings, SessionBinding } from './contracts.js';
import type { RuntimeResourcePolicy } from './runtime-factory.js';
import type { PreparedMessageResult, PreparedMessageIds } from '../services/conversation/conversation-adapter.js';

export type ServerSessionStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';

export type AbortOutcome =
  | { readonly kind: 'aborted'; readonly turnId: string; readonly discardedTurnIds: string[] }
  | { readonly kind: 'already_settled'; readonly turnId: string }
  | { readonly kind: 'no_op'; readonly turnId: string }
  | { readonly kind: 'interrupted'; readonly turnId: string; readonly reason: 'cancellation_timeout' };

export class ServerSessionError extends Error {
  readonly code: 'closed' | 'wrong_turn' | 'stale_interaction' | 'interrupted';
  constructor(code: ServerSessionError['code']) {
    super('server session operation rejected');
    this.name = 'ServerSessionError';
    this.code = code;
  }
}

export type ServerSessionEventContext = {
  readonly turnId?: string;
  readonly discardedTurnIds: readonly string[];
};

export type ServerSessionOptions = {
  binding: SessionBinding;
  service: ConversationService;
  composition: GatewaySessionComposition;
  policy: RuntimeResourcePolicy;
  eventSink?: (event: ConversationEvent, context: ServerSessionEventContext) => void | PromiseLike<void>;
  onDispose?: () => void;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ timedOut: true });
      },
    );
  });
}

export class ServerSession {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly binding: Readonly<SessionBinding>;
  readonly service: ConversationService;
  #status: ServerSessionStatus = 'idle';
  #activeTurnId: string | null = null;
  #abortGeneration = 0;
  #settledTurns = new Set<string>();
  #cancelledLeases = new Set<string>();
  #disposePromise: Promise<void> | null = null;
  readonly #preparedTurns = new Map<string, string>();
  readonly #composition: GatewaySessionComposition;
  readonly #policy: RuntimeResourcePolicy;
  readonly #eventSink?: (event: ConversationEvent, context: ServerSessionEventContext) => void | PromiseLike<void>;
  readonly #onDispose?: () => void;
  readonly #disposeHooks = new Set<() => void | Promise<void>>();
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #lastAbortOutcome: AbortOutcome | undefined;

  constructor(options: ServerSessionOptions) {
    this.id = options.binding.sessionId;
    this.ownerUserId = options.binding.ownerUserId;
    this.workspaceId = options.binding.workspaceId;
    this.binding = Object.freeze({ ...options.binding });
    this.service = options.service;
    this.#composition = options.composition;
    this.#policy = options.policy;
    this.#eventSink = options.eventSink;
    this.#onDispose = options.onDispose;
    this.service.setQueuedTurnStartObserver((execution) => {
      if (this.#status === 'interrupted' || this.#status === 'closed') return;
      this.#activeTurnId = execution.requestId;
      this.#status = 'running';
      this.#startDeadline(execution.requestId);
    });
    this.service.setEventSink(async (event: ConversationEvent) => {
      if (event.type === 'approval_required') this.#status = 'awaiting_interaction';
      const discardedTurnIds = event.type === 'error' ? this.service.consumeFailureDiscardedTurnIds() : [];
      for (const discardedTurnId of discardedTurnIds) this.#settledTurns.add(discardedTurnId);
      const turnId = this.#activeTurnId ?? undefined;
      if (event.type === 'final' || event.type === 'error') {
        if (this.#activeTurnId) this.#settledTurns.add(this.#activeTurnId);
        this.#activeTurnId = null;
        this.#clearDeadline();
      }
      if (this.#status !== 'interrupted' && this.#status !== 'closed') {
        this.#status = this.#computePublicStatus();
      }
      try {
        await this.#eventSink?.(event, { turnId, discardedTurnIds });
      } catch (error) {
        this.#status = 'interrupted';
        this.service.closeAdmission();
        throw error;
      }
    });
  }

  get sessionId(): string {
    return this.id;
  }

  #computePublicStatus(): ServerSessionStatus {
    if (this.#status === 'interrupted' || this.#status === 'closed') return this.#status;
    if (this.#activeTurnId) {
      if (this.#status === 'awaiting_interaction') return 'awaiting_interaction';
      return 'running';
    }
    const approvals = this.service.backgroundSubagentApprovals?.getSnapshot?.();
    if (approvals && approvals.pendingCount > 0) return 'awaiting_interaction';
    const details = this.service.backgroundTaskControl?.listDetails?.() ?? [];
    for (const d of details) {
      if (d.kind === 'subagent') {
        if (d.status === 'awaiting_approval' || d.status === 'waiting_for_answer') {
          return 'awaiting_interaction';
        }
        if (d.status === 'running' || d.status === 'cancelling') {
          return 'running';
        }
      } else if (d.kind === 'shell') {
        if (d.status === 'running' || d.status === 'cancelling') {
          return 'running';
        }
      }
    }
    return 'idle';
  }

  get status(): ServerSessionStatus {
    if (this.#status === 'interrupted' || this.#status === 'closed') return this.#status;
    return this.#computePublicStatus();
  }

  get activeTurnId(): string | null {
    return this.#activeTurnId;
  }

  get abortGeneration(): number {
    return this.#abortGeneration;
  }

  get lastAbortOutcome(): AbortOutcome | undefined {
    return this.#lastAbortOutcome;
  }

  get settings(): Readonly<SecretFreeWorkerSettings> {
    return Object.freeze({ ...this.#composition.settings });
  }

  get resources(): GatewaySessionComposition {
    return this.#composition;
  }

  /** Register lifecycle ownership without replacing the class dispose method. */
  addDisposeHook(hook: () => void | Promise<void>): void {
    if (this.#disposePromise) {
      hook();
      return;
    }
    this.#disposeHooks.add(hook);
  }

  prepareMessage(input: UserTurn | string, ids: PreparedMessageIds): Promise<PreparedMessageResult> {
    if (this.#status === 'closed' || this.#status === 'interrupted') {
      return Promise.resolve({ kind: 'rejected', reason: 'closed' });
    }
    return this.service.prepareMessage(input, ids).then((result) => {
      if (result.kind === 'prepared') this.#preparedTurns.set(result.leaseId, result.turnId);
      return result;
    });
  }

  async commitMessage(leaseId: string): Promise<void> {
    this.assertOpen();
    const turnId = this.#preparedTurns.get(leaseId);
    if (!turnId) throw new ServerSessionError('wrong_turn');
    const resetBudget = (this.#composition.providerBroker as { resetRequestBudget?: () => void }).resetRequestBudget;
    resetBudget?.();
    try {
      await this.service.commitMessage(leaseId);
    } catch (error) {
      this.#preparedTurns.delete(leaseId);
      throw error;
    }
    this.#preparedTurns.delete(leaseId);
    if (!this.#activeTurnId) {
      this.#activeTurnId = turnId;
      this.#status = 'running';
      this.#startDeadline(turnId);
    }
  }

  async cancelPreparedMessage(leaseId: string): Promise<void> {
    if (this.#status === 'closed') throw new ServerSessionError('closed');
    if (this.#cancelledLeases.has(leaseId)) return;
    await this.service.cancelPreparedMessage(leaseId);
    this.#preparedTurns.delete(leaseId);
    this.#cancelledLeases.add(leaseId);
  }

  resolvePendingInteraction(request: ResolvePendingInteractionRequest): PendingInteractionResolution {
    this.assertOpen();
    const result = this.service.resolvePendingInteraction(request);
    if (result.kind === 'stale_interaction') throw new ServerSessionError('stale_interaction');
    return result;
  }

  async abort(turnId: string): Promise<AbortOutcome> {
    if (this.#settledTurns.has(turnId)) return { kind: 'already_settled', turnId };
    if (this.#status === 'closed') return { kind: 'already_settled', turnId };
    if (this.#status === 'interrupted') {
      const outcome: AbortOutcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
      this.#lastAbortOutcome = outcome;
      return outcome;
    }
    if (!this.#activeTurnId) return { kind: 'no_op', turnId };
    if (this.#activeTurnId !== turnId) throw new ServerSessionError('wrong_turn');

    // Close admission before awaiting the bounded barrier. This makes a
    // cancellation race fail closed instead of letting fresh work auto-run.
    this.#abortGeneration += 1;
    this.service.closeAdmission();
    try {
      const result = await this.service.abortAndDiscard();
      if (!result.proven) {
        const outcome: AbortOutcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
        this.#status = 'interrupted';
        this.#lastAbortOutcome = outcome;
        return outcome;
      }
      this.#settledTurns.add(turnId);
      for (const discardedTurnId of result.discardedTurnIds) this.#settledTurns.add(discardedTurnId);
      this.#preparedTurns.clear();
      this.#activeTurnId = null;
      this.#status = this.#computePublicStatus();
      this.#clearDeadline();
      this.service.reopenAdmission();
      const outcome: AbortOutcome = { kind: 'aborted', turnId, discardedTurnIds: result.discardedTurnIds };
      this.#lastAbortOutcome = outcome;
      return outcome;
    } catch {
      this.#status = 'interrupted';
      const outcome: AbortOutcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
      this.#lastAbortOutcome = outcome;
      return outcome;
    }
  }

  async dispose(reason: 'closed' | 'shutdown' | 'interrupted' = 'closed'): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      this.service.closeAdmission();
      this.#preparedTurns.clear();
      this.#clearDeadline();
      let interrupted = reason === 'interrupted';
      const cancellation = await withTimeout(this.service.abortAndDiscard(), this.#policy.shutdownGraceMs);
      if (cancellation.timedOut || !cancellation.value?.proven) interrupted = true;
      const shutdown = await withTimeout(this.service.shutdown(), this.#policy.shutdownGraceMs);
      if (shutdown.timedOut) interrupted = true;
      await Promise.resolve(this.#composition.dispose());
      this.#activeTurnId = null;
      this.#status = interrupted && reason === 'interrupted' ? 'interrupted' : 'closed';
      for (const hook of this.#disposeHooks) await hook();
      this.#disposeHooks.clear();
      this.#onDispose?.();
    })();
    return this.#disposePromise;
  }

  private assertOpen(): void {
    if (this.#status === 'closed') throw new ServerSessionError('closed');
    if (this.#status === 'interrupted') throw new ServerSessionError('interrupted');
  }

  #startDeadline(turnId: string): void {
    this.#clearDeadline();
    this.#deadline = setTimeout(() => {
      void this.abort(turnId).then(
        (outcome) => {
          this.#lastAbortOutcome = outcome;
        },
        () => {
          this.#status = 'interrupted';
          this.#lastAbortOutcome = { kind: 'interrupted', turnId, reason: 'cancellation_timeout' };
        },
      );
    }, this.#policy.maxActiveTurnMs);
    this.#deadline.unref?.();
  }

  #clearDeadline(): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = undefined;
  }
}
