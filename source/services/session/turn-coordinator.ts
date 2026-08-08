import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { toTerminalEvent } from '../conversation/conversation-result-builder.js';
import { type UserTurn } from '../../types/user-turn.js';
import { TurnStatusMachine, type TurnCommand, type TurnLease, type TurnOutcome } from './turn-status-machine.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { getToolInfoFromInterruption } from '../interruption-info.js';
import type { TurnWorkflow } from './turn-workflow.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { InitialTurnRunOptions } from './turn-attempt-factory.js';
import { randomUUID } from 'node:crypto';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import type { SteerOutcome } from '../agent-runtime/application-run-loop.js';

export type TurnStartOptions = Pick<
  InitialTurnRunOptions,
  | 'skipUserMessage'
  | 'replayFromHistory'
  | 'retries'
  | 'maxModelRetries'
  | 'signal'
  | 'resumeState'
  | 'resumePreviousResponseId'
  | 'bypassInputSurgeGuard'
> & { origin?: 'user' | 'queued' };

export interface TurnCoordinatorDeps {
  statusMachine: TurnStatusMachine;
  turnWorkflow: TurnWorkflow;
  approvalFlow: ApprovalFlowCoordinator;
  providerContinuity: ProviderContinuity;
  shellAutoApproval: ShellAutoApprovalResolver;
  sessionId?: string;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
}

export class TurnCoordinator {
  #activeTurnId: string | undefined;
  #activeTurnStartedAt = 0;

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  async *start(input: string | UserTurn, options: TurnStartOptions = {}): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('idle')) {
      throw new Error('Another foreground turn is already active.');
    }
    // Consume any approval aborted by Esc before admitting a new foreground
    // turn. The follow-up user message must be sent as a normal new turn, not
    // as a rejection reason used to continue the abandoned SDK run.
    this.deps.approvalFlow.getAbortedStatus();

    const lease = this.deps.statusMachine.beginTurn();
    // Before the hooks, the input preparation and the provider's own start-up:
    // a message steered during any of that belongs to this turn, and only this
    // method knows the turn exists that early.
    this.deps.turnWorkflow.openTurn?.();
    const turnId = this.deps.hookLifecycle && this.deps.hookEvents ? randomUUID() : undefined;
    this.#activeTurnId = turnId;
    this.#activeTurnStartedAt = turnId ? Date.now() : 0;
    this.deps.turnWorkflow.setHookTurnId?.(turnId);
    if (turnId) await this.#emitTurnStart(input, options.origin ?? 'user', turnId);
    let processed = false;
    try {
      const turnOutcome = yield* this.#forwardOwned(this.deps.turnWorkflow.executeInitial(input, options), lease);
      processed = true;

      await this.#emitTurnEnd(turnOutcome);

      yield* this.#executeTerminalCommand(this.deps.statusMachine.completeOutcome(turnOutcome, lease));
    } catch (error) {
      if (!processed) {
        await this.#emitTurnError(error);
        await this.#emitTurnEnd({ kind: 'failed' });
      }
      throw error;
    } finally {
      if (!processed) {
        // Error during initial run — reset status to idle
        this.deps.statusMachine.complete(lease);
      }
      this.#closeTurnIfSettled();
    }
  }

  async *continueAfterApproval({
    answer,
    rejectionReason,
    stopAfterApprovalResolution,
  }: {
    answer: string;
    rejectionReason?: string;
    stopAfterApprovalResolution?: boolean;
  }): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('awaiting_approval')) {
      throw new Error('No pending approval to continue.');
    }
    this.#recordManualShellDecision(answer);
    const lease = this.deps.statusMachine.beginContinuation();
    this.deps.turnWorkflow.setHookTurnId?.(this.#activeTurnId);
    let processed = false;
    try {
      const turnOutcome = yield* this.#forwardOwned(
        this.deps.turnWorkflow.executeContinuation(
          this.deps.approvalFlow.buildApprovalDecision(answer, rejectionReason, stopAfterApprovalResolution),
        ),
        lease,
      );
      processed = true;
      await this.#emitTurnEnd(turnOutcome);
      yield* this.#executeTerminalCommand(this.deps.statusMachine.completeContinuationOutcome(turnOutcome, lease));
    } catch (error) {
      if (!processed) {
        await this.#emitTurnError(error);
        await this.#emitTurnEnd({ kind: 'failed' });
      }
      throw error;
    } finally {
      if (!processed) {
        // Error during continuation drive — reset status to idle
        this.deps.statusMachine.complete(lease);
      }
      this.#closeTurnIfSettled();
    }
  }

  async *continueAfterPostExecuteApproval(): AsyncIterable<ConversationEvent> {
    if (!this.deps.statusMachine.is('awaiting_approval')) {
      throw new Error('No pending approval to continue.');
    }
    const lease = this.deps.statusMachine.beginContinuation();
    this.deps.turnWorkflow.setHookTurnId?.(this.#activeTurnId);
    let processed = false;
    try {
      const turnOutcome = yield* this.#forwardOwned(this.deps.turnWorkflow.continuePostExecute(), lease);
      processed = true;
      await this.#emitTurnEnd(turnOutcome);
      yield* this.#executeTerminalCommand(this.deps.statusMachine.completeContinuationOutcome(turnOutcome, lease));
    } catch (error) {
      if (!processed) {
        await this.#emitTurnError(error);
        await this.#emitTurnEnd({ kind: 'failed' });
      }
      throw error;
    } finally {
      if (!processed) this.deps.statusMachine.complete(lease);
      this.#closeTurnIfSettled();
    }
  }

  abort(): void {
    this.deps.turnWorkflow.abortLiveRun();
    this.deps.approvalFlow.abort();
    this.deps.statusMachine.abort();
    this.deps.providerContinuity.clear();
    this.deps.turnWorkflow.closeTurn?.();
    void this.#emitTurnEnd({ kind: 'failed' });
  }

  /** Close a live turn before a lifecycle reset invalidates its lease. */
  terminate(): void {
    void this.#emitTurnEnd({ kind: 'failed' });
  }

  /**
   * Admit a user message into the running turn.
   *
   * A turn parked on an approval is paused, not over: answering it resumes the
   * turn with another request boundary ahead. The message waits for that
   * boundary rather than being refused, which is the state the user is most
   * likely to be typing in — the approval pause is the visible gap in a turn.
   */
  steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome> {
    return this.deps.turnWorkflow.steer(items, options);
  }

  /** Drop a still-waiting steer. False when it was already admitted. */
  retractSteer(id: string): boolean {
    return this.deps.turnWorkflow.retractSteer(id);
  }

  /** Replace a waiting steer's items in place, keeping its position. */
  editSteer(id: string, items: readonly ProviderInputItem[]): boolean {
    return this.deps.turnWorkflow.editSteer(id, items);
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * End the turn's steer scope only once the turn itself is over.
   *
   * A turn parked on an approval has returned from `start` without finishing:
   * the status machine still holds it, and `continueAfterApproval` will offer
   * another request boundary. Idle is the one state that means no boundary is
   * coming.
   */
  #closeTurnIfSettled(): void {
    if (this.deps.statusMachine.is('idle')) this.deps.turnWorkflow.closeTurn?.();
  }

  /** Records the human's shell/bash approval so later auto-approval evaluations can weigh it as precedent. */
  #recordManualShellDecision(answer: string): void {
    const pending = this.deps.approvalFlow.getPending();
    if (!pending) return;
    const { toolName, argumentsText } = getToolInfoFromInterruption(pending.interruption);
    if (toolName !== 'shell' && toolName !== 'bash') return;
    this.deps.shellAutoApproval.recordManualDecision(argumentsText, answer === 'n' ? 'rejected' : 'approved');
  }

  async *#forwardOwned(
    events: AsyncGenerator<ConversationEvent, TurnOutcome, void>,
    lease: TurnLease,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    while (true) {
      const next = await events.next();
      if (!this.deps.statusMachine.owns(lease)) {
        await events.return({ kind: 'stale' });
        return { kind: 'stale' };
      }
      if (next.done) return next.value;
      yield next.value;
    }
  }

  async *#executeTerminalCommand(command: TurnCommand): AsyncGenerator<ConversationEvent, void, void> {
    if (command.kind === 'emit_terminal') {
      yield toTerminalEvent(command.terminal);
    }
  }

  async #emitTurnStart(input: string | UserTurn, origin: 'user' | 'queued', turnId: string): Promise<void> {
    if (!this.deps.hookLifecycle || !this.deps.hookEvents) return;
    const text = typeof input === 'string' ? input : input.text;
    await this.#emit(
      this.deps.hookEvents.create(
        'turn.start',
        {
          origin,
          ...(this.deps.hookEvents.includeUserText ? { userText: text } : {}),
        },
        { turnId },
      ),
    );
  }

  async #emitTurnError(error: unknown): Promise<void> {
    if (!this.#activeTurnId || !this.deps.hookLifecycle || !this.deps.hookEvents) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.#emit(
      this.deps.hookEvents.create(
        'turn.error',
        {
          errorCategory: 'unknown',
          safeMessage: message.slice(0, 500),
          recoverable: false,
        },
        { turnId: this.#activeTurnId },
      ),
    );
  }

  async #emitTurnEnd(outcome: TurnOutcome): Promise<void> {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    const terminalKind = outcome.kind;
    const shouldClear = terminalKind !== 'approval_required';
    if (this.deps.hookLifecycle && this.deps.hookEvents) {
      const event = this.deps.hookEvents.create(
        'turn.end',
        {
          terminalKind,
          duration: Math.max(0, Date.now() - this.#activeTurnStartedAt),
        },
        { turnId },
      );
      if (shouldClear) {
        this.#activeTurnId = undefined;
        this.#activeTurnStartedAt = 0;
        this.deps.turnWorkflow.setHookTurnId?.(undefined);
      }
      await this.#emit(event);
    } else if (shouldClear) {
      this.#activeTurnId = undefined;
      this.#activeTurnStartedAt = 0;
      this.deps.turnWorkflow.setHookTurnId?.(undefined);
    }
  }

  async #emit(event: Parameters<HookLifecyclePort['emit']>[0]): Promise<void> {
    try {
      await this.deps.hookLifecycle?.emit(event as never);
    } catch {
      // Public hooks are passive and fail open.
    }
  }
}
