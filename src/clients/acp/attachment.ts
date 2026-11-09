import type { AcpClient } from './contract.js';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type {
  WireBranchSnapshot,
  WireBudgetRequest,
  WireCommand,
  WireEvent,
  WireInteraction,
} from '../../protocol/wire.js';
import { reduceWireEvent } from '../../protocol/reducer.js';
import type { AcpLogger, EmitUpdate, PromptExecution, PromptOutcome } from './contract.js';
import { errorMessage } from './contract.js';
import { AcpRenderer, MissingAcpWireContract, terminalOutcome } from './render.js';
import { requestPermission } from './permissions.js';
import { requestBudget } from './budget.js';
import type { PromptInput } from './input.js';

type ActivePrompt = {
  turnId: string | null;
  messageId: string | null;
  readonly ready: Promise<void>;
  release(): void;
  readonly admitted: Promise<void>;
  finishAdmission(): void;
  readonly outcome: Promise<PromptOutcome>;
  resolve(outcome: PromptOutcome): void;
  reject(error: unknown): void;
  emit?: EmitUpdate;
  signal?: AbortSignal;
};

function reservePrompt(): ActivePrompt {
  let release!: () => void;
  let finishAdmission!: () => void;
  let resolve!: (outcome: PromptOutcome) => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((done) => {
    release = done;
  });
  const outcome = new Promise<PromptOutcome>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const admitted = new Promise<void>((done) => {
    finishAdmission = done;
  });
  // Admission or a broken subscription can fail before the scheduled run starts.
  void outcome.catch(() => undefined);
  return { turnId: null, messageId: null, ready, release, admitted, finishAdmission, outcome, resolve, reject };
}

type RequestTask = {
  readonly turnId: string | null;
  readonly controller: AbortController;
  readonly done: Promise<void>;
};

/**
 * One ACP attachment owns a subscription, renderer and in-flight ACP requests.
 * Its event pump never acknowledges engine work, and disconnect never cancels
 * the shared Session. Explicit cancellation is a separate wire command.
 */
export class AcpAttachment {
  private readonly renderer = new AcpRenderer();
  private readonly branchRenderers = new Map<string, AcpRenderer>();
  private readonly lifetime = new AbortController();
  private readonly requests = new Map<string, RequestTask>();
  private active: ActivePrompt | null = null;
  private closed = false;
  private foregroundTurnId: string | null;
  private status: DirectConnection['snapshot']['status'];
  private activity: DirectConnection['snapshot'];
  private closeWaiter: { readonly turnId: string; resolve(): void; reject(error: unknown): void } | null = null;
  private pump: Promise<void> = Promise.resolve();

  constructor(
    readonly connection: DirectConnection,
    private readonly client: AcpClient,
    private readonly logger: AcpLogger,
  ) {
    this.foregroundTurnId = connection.snapshot.activeTurnId;
    this.status = connection.snapshot.status;
    this.activity = connection.snapshot;
  }

  /** Replay a current snapshot before consuming its strictly subsequent events. */
  async start(replay: boolean): Promise<void> {
    for (const update of this.renderer.snapshot(this.connection.snapshot, replay)) await this.emit(update);
    await this.syncBranches(this.connection.snapshot.branches, replay);
    // Current activity is live synchronization, even when history is omitted.
    await this.emit({
      sessionUpdate: 'state_update',
      state:
        this.status === 'awaiting_interaction' ? 'requires_action' : this.status === 'running' ? 'running' : 'idle',
    });
    for (const permission of this.connection.snapshot.pendingInteractions) this.openPermission(permission);
    for (const request of this.connection.snapshot.pendingBudgets ?? []) this.openBudget(request);
    this.pump = this.consume().catch((error: unknown) => this.fail(error));
  }

  /** Reserve before awaiting admission so simultaneous prompts cannot both enter. */
  async prepare(requestId: string, input: PromptInput): Promise<PromptExecution> {
    if (this.closed) throw new acp.RequestError(-32001, 'ACP session attachment is closed');
    if (this.active) throw new acp.RequestError(-32000, 'Session is already processing foreground work');
    const prompt = reservePrompt();
    this.active = prompt;
    try {
      const result = await this.connection.send({
        type: 'submit',
        requestId,
        text: input.text,
        attachments: input.attachments,
        origin: { kind: 'acp' },
        delivery: 'reject_if_busy',
      });
      if (!result.ok) throw new acp.RequestError(-32000, result.message);
      if (result.kind !== 'admitted') throw new MissingAcpWireContract('submit admission receipt');
      const admission = result.admission;
      if (admission.kind === 'rejected') throw new acp.RequestError(-32000, admission.reason);
      if (admission.kind === 'duplicate')
        throw new acp.RequestError(-32009, 'ACP client request id was already admitted');
      prompt.messageId = admission.messageId;
      this.client.promptAccepted?.(this.connection.sessionId, admission.messageId);
      prompt.turnId = admission.turnId ?? null;
      if (admission.kind !== 'started') {
        throw new MissingAcpWireContract('reject_if_busy must not queue or steer admitted ACP input');
      }
      if (this.closed) throw new Error('ACP connection closed during admission');
    } catch (error) {
      if (this.active === prompt) this.active = null;
      prompt.reject(error);
      prompt.release();
      throw error;
    } finally {
      prompt.finishAdmission();
    }
    let ran = false;
    return {
      run: async (emit, signal) => {
        if (ran) throw new Error('ACP prompt execution can only run once');
        ran = true;
        prompt.emit = emit;
        prompt.signal = signal;
        prompt.release();
        try {
          // Even an already-cancelled prompt must observe its real terminal;
          // admission/cancel receipts are not evidence physical work stopped.
          return await prompt.outcome;
        } finally {
          if (this.active === prompt) this.active = null;
        }
      },
    };
  }

  /** Cancel foreground work explicitly; only its actual terminal settles the prompt. */
  async cancel(): Promise<void> {
    // Capture ownership before awaiting admission. A cancel received while
    // submit is in flight must target that prompt, never a replacement turn.
    const prompt = this.active;
    const foregroundTurnId = this.foregroundTurnId;
    await prompt?.admitted;
    const turnId = prompt ? prompt.turnId : foregroundTurnId;
    if (!turnId) return;
    for (const task of this.requests.values()) {
      if (task.turnId === turnId) task.controller.abort();
    }
    // Compare under Session admission ownership, never cancel a replacement turn
    // or discard another client's queued work from an ACP cancellation.
    const result = await this.connection.send({ type: 'cancel', expectedTurnId: turnId, discardQueue: false });
    if (!result.ok) throw new acp.RequestError(-32000, result.message);
  }

  /** Explicit close cancels and observes known foreground work, then detaches. */
  async close(): Promise<void> {
    const prompt = this.active;
    let terminal: Promise<void> | undefined;
    if (!prompt && this.foregroundTurnId) {
      const turnId = this.foregroundTurnId;
      terminal = new Promise<void>((resolve, reject) => {
        this.closeWaiter = { turnId, resolve, reject };
      });
      void terminal.catch(() => undefined);
    }
    try {
      await this.cancel();
      if (prompt) await prompt.outcome;
      else if (terminal) await terminal;
      else if (this.status === 'running' || this.status === 'awaiting_interaction') {
        throw new MissingAcpWireContract('activeTurnId needed to observe close cancellation');
      }
    } finally {
      this.detach();
    }
  }

  /** Detach only: transport EOF must not silently cancel other clients' work. */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const task of this.requests.values()) task.controller.abort();
    this.requests.clear();
    this.branchRenderers.clear();
    this.active?.release();
    this.active?.reject(new Error('ACP session attachment closed'));
    this.closeWaiter?.reject(new Error('ACP session attachment closed'));
    this.closeWaiter = null;
    this.connection.close();
  }

  private emit(update: acp.SessionUpdate): Promise<void> {
    return this.client.update({ sessionId: this.connection.sessionId, update });
  }

  private async consume(): Promise<void> {
    for await (const event of this.connection.events) {
      // The host keeps accepting/persisting independently; this is an ACP output
      // ordering gate only, not an execution gate or a Session acknowledgement.
      await this.active?.ready;
      if (this.closed) return;
      if (event.sessionId !== this.connection.sessionId) throw new Error('ACP received an event for another session');
      await this.onEvent(event);
    }
    if (!this.closed) throw new Error('ACP host subscription ended unexpectedly');
  }

  private async onEvent(event: WireEvent, nested = false, renderer = this.renderer): Promise<void> {
    if (event.type === 'subagent') {
      const branchId = event.payload.branchId ?? event.payload.agentId;
      let branch = this.branchRenderers.get(branchId);
      if (!branch) {
        branch = new AcpRenderer();
        this.branchRenderers.set(branchId, branch);
      }
      await this.onEvent(event.payload.event, true, branch);
      return;
    }
    if (!nested) {
      // Native interaction facts change foreground state without a
      // separate status_changed event. Use the protocol's state semantics,
      // including concurrent requests and background task distinctions.
      this.activity = reduceWireEvent(this.activity, event);
      await this.updateStatus(this.activity.status);
    }
    if (!nested && event.type === 'turn_started') {
      if (event.payload.foreground) this.foregroundTurnId = event.turnId;
      if (this.active?.messageId && event.payload.input.some((message) => message.id === this.active?.messageId)) {
        this.active.turnId = event.turnId;
      }
    }
    if (!nested && event.type === 'snapshot') {
      this.foregroundTurnId = event.payload.snapshot.activeTurnId;
      const snapshot = event.payload.snapshot;
      for (const terminal of [...(snapshot.turnResults ?? []), ...(snapshot.terminal ? [snapshot.terminal] : [])]) {
        if (this.active?.turnId === terminal.turnId) this.active.resolve(terminalOutcome(terminal));
        if (this.closeWaiter?.turnId === terminal.turnId) this.closeWaiter.resolve();
      }
      const pending = new Set([
        ...snapshot.pendingInteractions.map((interaction) => interaction.requestId),
        ...(snapshot.pendingBudgets ?? []).map((request) => request.requestId),
      ]);
      for (const [id, task] of this.requests) {
        if (!pending.has(id)) {
          task.controller.abort();
          this.requests.delete(id);
        }
      }
      for (const interaction of snapshot.pendingInteractions) this.openPermission(interaction);
      for (const request of snapshot.pendingBudgets ?? []) this.openBudget(request);
    }
    if (!nested && event.type === 'snapshot') await this.syncBranches(event.payload.snapshot.branches);
    for (const update of renderer.event(event)) await (this.active?.emit ?? this.emit.bind(this))(update);
    if (event.type === 'interaction_opened') {
      this.openPermission(event.payload.interaction);
    }
    if (event.type === 'budget_opened') this.openBudget(event.payload.request);
    if (event.type === 'interaction_resolved' || event.type === 'budget_closed') {
      this.requests.get(event.payload.requestId)?.controller.abort();
      this.requests.delete(event.payload.requestId);
    }
    if (event.type === 'turn_ended') {
      for (const [id, task] of this.requests) {
        if (task.turnId === event.turnId) {
          task.controller.abort();
          this.requests.delete(id);
        }
      }
    }
    if (!nested && event.type === 'turn_ended') {
      if (this.active && event.turnId === this.active.turnId) this.active.resolve(terminalOutcome(event.payload));
      if (this.closeWaiter?.turnId === event.turnId) this.closeWaiter.resolve();
      if (this.foregroundTurnId === event.turnId) {
        this.foregroundTurnId = null;
        this.status = 'idle';
        if (!this.active)
          await this.emit({ sessionUpdate: 'state_update', state: 'idle', ...terminalOutcome(event.payload) });
      }
    }
  }

  /** Each accepted branch retains its own display aliases and mixed transcript order. */
  private async syncBranches(branches: readonly WireBranchSnapshot[] | undefined, replay = true): Promise<void> {
    for (const snapshot of branches ?? []) {
      let renderer = this.branchRenderers.get(snapshot.branchId);
      const fresh = !renderer;
      if (!renderer) {
        renderer = new AcpRenderer();
        this.branchRenderers.set(snapshot.branchId, renderer);
      }
      const updates = fresh ? renderer.snapshot(snapshot, replay) : renderer.refresh(snapshot);
      for (const update of updates) await (this.active?.emit ?? this.emit.bind(this))(update);
    }
  }

  private async updateStatus(status: DirectConnection['snapshot']['status']): Promise<void> {
    const previous = this.status;
    this.status = status;
    if (previous !== status && (status === 'running' || status === 'awaiting_interaction')) {
      await this.emit({
        sessionUpdate: 'state_update',
        state: status === 'awaiting_interaction' ? 'requires_action' : 'running',
      });
    }
  }

  private openPermission(interaction: WireInteraction): void {
    this.openRequest(interaction.requestId, interaction.turnId, async (signal) => ({
      type: 'answer',
      requestId: interaction.requestId,
      ...(await requestPermission({ sessionId: this.connection.sessionId, interaction, client: this.client, signal })),
    }));
  }

  private openBudget(request: WireBudgetRequest): void {
    this.openRequest(request.requestId, request.turnId, async (signal) => ({
      type: 'answer_budget',
      requestId: request.requestId,
      ...(await requestBudget({ sessionId: this.connection.sessionId, request, client: this.client, signal })),
    }));
  }

  /** Each real request owns one cancellable client exchange and one targeted native answer. */
  private openRequest(requestId: string, turnId: string, command: (signal: AbortSignal) => Promise<WireCommand>): void {
    if (this.closed || this.requests.has(requestId)) return;
    const controller = new AbortController();
    const signals = [this.lifetime.signal, controller.signal];
    if (this.active?.turnId === turnId && this.active?.signal) signals.push(this.active.signal);
    const signal = AbortSignal.any(signals);
    const done = this.answerRequest(command, signal).catch((error: unknown) => {
      if (!signal.aborted) this.fail(error);
    });
    this.requests.set(requestId, { turnId, controller, done });
  }

  private async answerRequest(
    command: (signal: AbortSignal) => Promise<WireCommand>,
    signal: AbortSignal,
  ): Promise<void> {
    const answer = await command(signal);
    // A resolved request or detached subscription has no remaining owner to answer.
    if (signal.aborted) return;
    const result = await this.connection.send(answer);
    // Another connection may have resolved it while the user was choosing.
    if (!result.ok && result.code !== 'stale_interaction') throw new acp.RequestError(-32000, result.message);
  }

  private fail(error: unknown): void {
    this.active?.reject(error);
    this.logger.error('Direct ACP attachment failed', {
      eventType: 'acp.attachment.failed',
      sessionId: this.connection.sessionId,
      errorMessage: errorMessage(error),
    });
    this.detach();
  }
}
