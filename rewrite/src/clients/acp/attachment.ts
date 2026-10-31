import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireEvent, WireInteraction } from '../../protocol/direct-wire.js';
import type { AcpLogger, EmitUpdate, PromptExecution, PromptOutcome } from './contract.js';
import { errorMessage } from './contract.js';
import { AcpRenderer, MissingAcpWireContract, terminalOutcome } from './render.js';
import { requestPermission } from './permissions.js';

type ActivePrompt = {
  turnId: string | null;
  messageId: string | null;
  disposition: 'started' | 'queued' | 'steering' | null;
  readonly ready: Promise<void>;
  release(): void;
  readonly outcome: Promise<PromptOutcome>;
  resolve(outcome: PromptOutcome): void;
  reject(error: unknown): void;
  emit?: EmitUpdate;
  signal?: AbortSignal;
};

function reservePrompt(): ActivePrompt {
  let release!: () => void;
  let resolve!: (outcome: PromptOutcome) => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((done) => {
    release = done;
  });
  const outcome = new Promise<PromptOutcome>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // Admission or a broken subscription can fail before the scheduled run starts.
  void outcome.catch(() => undefined);
  return { turnId: null, messageId: null, disposition: null, ready, release, outcome, resolve, reject };
}

type PermissionTask = {
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
  private readonly lifetime = new AbortController();
  private readonly permissions = new Map<string, PermissionTask>();
  private active: ActivePrompt | null = null;
  private closed = false;
  private foregroundTurnId: string | null;
  private status: DirectConnection['snapshot']['status'];
  private closeWaiter: { readonly turnId: string; resolve(): void; reject(error: unknown): void } | null = null;
  private pump: Promise<void> = Promise.resolve();

  constructor(
    readonly connection: DirectConnection,
    private readonly client: acp.AgentContext,
    private readonly logger: AcpLogger,
  ) {
    this.foregroundTurnId = connection.snapshot.activeTurnId;
    this.status = connection.snapshot.status;
  }

  /** Replay a current snapshot before consuming its strictly subsequent events. */
  async start(replay: boolean): Promise<void> {
    for (const update of this.renderer.snapshot(this.connection.snapshot, replay)) await this.emit(update);
    if (replay && (this.status === 'running' || this.status === 'awaiting_interaction')) {
      await this.emit({ sessionUpdate: 'state_update', state: 'running' });
    }
    for (const permission of this.connection.snapshot.pendingInteractions) this.openPermission(permission);
    this.pump = this.consume().catch((error: unknown) => this.fail(error));
  }

  /** Reserve before awaiting admission so simultaneous prompts cannot both enter. */
  async prepare(requestId: string, text: string): Promise<PromptExecution> {
    if (this.closed) throw new acp.RequestError(-32001, 'ACP session attachment is closed');
    if (this.active) throw new acp.RequestError(-32000, 'Session is already processing foreground work');
    const prompt = reservePrompt();
    this.active = prompt;
    try {
      const result = await this.connection.send({ type: 'submit', requestId, text, origin: { kind: 'acp' } });
      if (!result.ok) throw new acp.RequestError(-32000, result.message);
      if (result.kind !== 'admitted') throw new MissingAcpWireContract('submit admission receipt');
      const admission = result.admission;
      if (admission.kind === 'rejected') throw new acp.RequestError(-32000, admission.reason);
      if (admission.kind === 'duplicate')
        throw new acp.RequestError(-32009, 'ACP client request id was already admitted');
      prompt.messageId = admission.messageId;
      prompt.disposition = admission.kind;
      prompt.turnId = admission.turnId ?? null;
      if (admission.kind === 'steering' && !prompt.turnId) {
        throw new MissingAcpWireContract('steering receipt needs owning turnId for ACP completion');
      }
      if (this.closed) throw new Error('ACP connection closed during admission');
    } catch (error) {
      if (this.active === prompt) this.active = null;
      prompt.reject(error);
      prompt.release();
      throw error;
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

  /** Cancel explicitly; a queued prompt is retracted rather than cancelling another turn. */
  async cancel(): Promise<void> {
    const prompt = this.active;
    if (prompt?.disposition === 'queued' && !prompt.turnId && prompt.messageId) {
      const result = await this.connection.send({ type: 'queue_retract', messageId: prompt.messageId });
      if (!result.ok) throw new acp.RequestError(-32000, result.message);
      if (result.kind !== 'accepted') throw new MissingAcpWireContract('queue retraction result');
      // Successful retraction removed unstarted work; there is no physical run
      // whose terminal needs observing. A racing start must reject retraction.
      prompt.resolve({ stopReason: 'cancelled' });
      return;
    }
    for (const task of this.permissions.values()) {
      if (prompt?.turnId && task.turnId === prompt.turnId) task.controller.abort();
    }
    const result = await this.connection.send({ type: 'cancel', target: { kind: 'foreground' } });
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
    for (const task of this.permissions.values()) task.controller.abort();
    this.permissions.clear();
    this.active?.release();
    this.active?.reject(new Error('ACP session attachment closed'));
    this.closeWaiter?.reject(new Error('ACP session attachment closed'));
    this.closeWaiter = null;
    this.connection.close();
  }

  private emit(update: acp.SessionUpdate): Promise<void> {
    return this.client.notify(acp.methods.client.session.update, { sessionId: this.connection.sessionId, update });
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

  private async onEvent(event: WireEvent): Promise<void> {
    if (event.type === 'subagent') {
      await this.onEvent(event.payload.event);
      return;
    }
    if (event.type === 'turn_started') {
      if (event.payload.foreground) this.foregroundTurnId = event.turnId;
      if (this.active?.messageId && event.payload.input.some((message) => message.id === this.active?.messageId)) {
        this.active.turnId = event.turnId;
        this.active.disposition = 'started';
      }
    }
    if (event.type === 'snapshot') {
      this.foregroundTurnId = event.payload.snapshot.activeTurnId;
      this.status = event.payload.snapshot.status;
      const pending = new Set(event.payload.snapshot.pendingInteractions.map((interaction) => interaction.requestId));
      for (const [id, task] of this.permissions) {
        if (!pending.has(id)) {
          task.controller.abort();
          this.permissions.delete(id);
        }
      }
      for (const interaction of event.payload.snapshot.pendingInteractions) this.openPermission(interaction);
    }
    if (event.type === 'status_changed') {
      const wasRunning = this.status === 'running' || this.status === 'awaiting_interaction';
      this.status = event.payload.status;
      if (!this.active && !wasRunning && (this.status === 'running' || this.status === 'awaiting_interaction')) {
        await this.emit({ sessionUpdate: 'state_update', state: 'running' });
      }
    }
    for (const update of this.renderer.event(event)) await (this.active?.emit ?? this.emit.bind(this))(update);
    if (event.type === 'interaction_opened') {
      this.openPermission(event.payload.interaction);
    }
    if (event.type === 'interaction_resolved') {
      this.permissions.get(event.payload.requestId)?.controller.abort();
      this.permissions.delete(event.payload.requestId);
    }
    if (event.type === 'turn_ended') {
      if (this.active && event.turnId === this.active.turnId) this.active.resolve(terminalOutcome(event));
      if (this.closeWaiter?.turnId === event.turnId) this.closeWaiter.resolve();
      if (this.foregroundTurnId === event.turnId) {
        this.foregroundTurnId = null;
        this.status = 'idle';
        if (!this.active) await this.emit({ sessionUpdate: 'state_update', state: 'idle', ...terminalOutcome(event) });
      }
    }
  }

  private openPermission(permission: WireInteraction): void {
    if (this.closed || this.permissions.has(permission.requestId)) return;
    const controller = new AbortController();
    const signals = [this.lifetime.signal, controller.signal];
    if (this.active?.turnId === permission.turnId && this.active?.signal) signals.push(this.active.signal);
    const signal = AbortSignal.any(signals);
    const done = this.answerPermission(permission, signal).catch((error: unknown) => {
      if (!signal.aborted) this.fail(error);
    });
    this.permissions.set(permission.requestId, { turnId: permission.turnId, controller, done });
  }

  private async answerPermission(permission: WireInteraction, signal: AbortSignal): Promise<void> {
    const decision = await requestPermission({
      sessionId: this.connection.sessionId,
      interaction: permission,
      client: this.client,
      signal,
    });
    // A resolved interaction or a detached subscription has no remaining owner
    // to answer. Explicit cancellation is already routed through the host.
    if (signal.aborted) return;
    const result = await this.connection.send({ type: 'answer', requestId: permission.requestId, decision });
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
