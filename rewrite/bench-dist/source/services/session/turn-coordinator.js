import { toTerminalEvent } from '../conversation/conversation-result-builder.js';
import { getToolInfoFromInterruption } from '../interruption-info.js';
import { randomUUID } from 'node:crypto';
import { AutomaticMemoryFinalizer } from './automatic-memory-finalizer.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
export class TurnCoordinator {
    deps;
    #activeTurnId;
    #activeTurnStartedAt = 0;
    #automaticMemoryFinalizer;
    constructor(deps) {
        this.deps = deps;
        this.#automaticMemoryFinalizer = deps.automaticMemoryFinalizer ?? new AutomaticMemoryFinalizer(deps);
    }
    async *start(input, options = {}) {
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
        this.deps.turnAdapter.openTurn?.();
        const turnId = this.deps.hookLifecycle && this.deps.hookEvents ? randomUUID() : undefined;
        this.#activeTurnId = turnId;
        this.#activeTurnStartedAt = turnId ? Date.now() : 0;
        this.deps.turnAdapter.setHookTurnId?.(turnId);
        if (turnId)
            await this.#emitTurnStart(input, options.origin ?? 'user', turnId);
        let processed = false;
        try {
            const forwarded = yield* this.#forwardOwned(this.deps.turnAdapter.executeInitial(input, options), lease);
            const turnOutcome = forwarded.outcome;
            processed = true;
            await this.#emitTurnEnd(turnOutcome);
            const failureEvent = this.#authoritativeFailureEvent(forwarded);
            if (failureEvent)
                yield failureEvent;
            yield* this.#executeTerminalCommand(this.deps.statusMachine.completeOutcome(turnOutcome, lease));
            if (turnOutcome.kind === 'response' &&
                !options.replayFromHistory &&
                !options.skipUserMessage &&
                !options.modelOnlyInput) {
                yield* this.#automaticMemoryFinalizer.record(input);
            }
        }
        catch (error) {
            if (!processed) {
                await this.#emitTurnError(error);
                await this.#emitTurnEnd({ kind: 'failed' });
            }
            throw error;
        }
        finally {
            if (!processed) {
                // Error during initial run — reset status to idle
                this.deps.statusMachine.complete(lease);
            }
            this.#closeTurnIfSettled();
        }
    }
    async *continueAfterApproval({ answer, rejectionReason, stopAfterApprovalResolution, }) {
        if (!this.deps.statusMachine.is('awaiting_approval')) {
            throw new Error('No pending approval to continue.');
        }
        this.#recordManualShellDecision(answer);
        const lease = this.deps.statusMachine.beginContinuation();
        this.deps.turnAdapter.setHookTurnId?.(this.#activeTurnId);
        let processed = false;
        try {
            const forwarded = yield* this.#forwardOwned(this.deps.turnAdapter.executeContinuation(this.deps.approvalFlow.buildApprovalDecision(answer, rejectionReason, stopAfterApprovalResolution)), lease);
            const turnOutcome = forwarded.outcome;
            processed = true;
            await this.#emitTurnEnd(turnOutcome);
            const failureEvent = this.#authoritativeFailureEvent(forwarded);
            if (failureEvent)
                yield failureEvent;
            yield* this.#executeTerminalCommand(this.deps.statusMachine.completeContinuationOutcome(turnOutcome, lease));
        }
        catch (error) {
            if (!processed) {
                await this.#emitTurnError(error);
                await this.#emitTurnEnd({ kind: 'failed' });
            }
            throw error;
        }
        finally {
            if (!processed) {
                // Error during continuation drive — reset status to idle
                this.deps.statusMachine.complete(lease);
            }
            this.#closeTurnIfSettled();
        }
    }
    async *continueAfterPostExecuteApproval() {
        if (!this.deps.statusMachine.is('awaiting_approval')) {
            throw new Error('No pending approval to continue.');
        }
        const lease = this.deps.statusMachine.beginContinuation();
        this.deps.turnAdapter.setHookTurnId?.(this.#activeTurnId);
        let processed = false;
        try {
            const forwarded = yield* this.#forwardOwned(this.deps.turnAdapter.continuePostExecute(), lease);
            const turnOutcome = forwarded.outcome;
            processed = true;
            await this.#emitTurnEnd(turnOutcome);
            const failureEvent = this.#authoritativeFailureEvent(forwarded);
            if (failureEvent)
                yield failureEvent;
            yield* this.#executeTerminalCommand(this.deps.statusMachine.completeContinuationOutcome(turnOutcome, lease));
        }
        catch (error) {
            if (!processed) {
                await this.#emitTurnError(error);
                await this.#emitTurnEnd({ kind: 'failed' });
            }
            throw error;
        }
        finally {
            if (!processed)
                this.deps.statusMachine.complete(lease);
            this.#closeTurnIfSettled();
        }
    }
    abort() {
        const completion = this.deps.turnAdapter.abortLiveRun();
        this.deps.approvalFlow.abort();
        this.deps.statusMachine.abort();
        this.deps.providerContinuity.clear();
        this.deps.turnAdapter.closeTurn?.();
        void this.#emitTurnEnd({ kind: 'failed' });
        return completion;
    }
    /** Close a live turn before a lifecycle reset invalidates its lease. */
    terminate() {
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
    steer(items, options) {
        return this.deps.turnAdapter.steer(items, options);
    }
    /** Drop a still-waiting steer. False when it was already admitted. */
    retractSteer(id) {
        return this.deps.turnAdapter.retractSteer(id);
    }
    /** Replace a waiting steer's items in place, keeping its position. */
    editSteer(id, items) {
        return this.deps.turnAdapter.editSteer(id, items);
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
    #closeTurnIfSettled() {
        if (this.deps.statusMachine.is('idle'))
            this.deps.turnAdapter.closeTurn?.();
    }
    /** Records the human's shell/bash approval so later auto-approval evaluations can weigh it as precedent. */
    #recordManualShellDecision(answer) {
        const pending = this.deps.approvalFlow.getPending();
        if (!pending)
            return;
        const { toolName, argumentsText } = getToolInfoFromInterruption(pending.interruption);
        if (toolName !== 'shell' && toolName !== 'bash')
            return;
        this.deps.shellAutoApproval.recordManualDecision(argumentsText, answer === 'n' ? 'rejected' : 'approved');
    }
    #authoritativeFailureEvent(forwarded) {
        if (forwarded.outcome.kind !== 'failed' || forwarded.sawAuthoritativeTerminal)
            return undefined;
        return {
            type: 'error',
            message: 'Conversation turn failed before producing an authoritative terminal event.',
        };
    }
    async *#forwardOwned(events, lease) {
        let sawAuthoritativeTerminal = false;
        try {
            while (true) {
                const next = await events.next();
                if (!this.deps.statusMachine.owns(lease)) {
                    await events.return({ kind: 'stale' });
                    return { outcome: { kind: 'stale' }, sawAuthoritativeTerminal };
                }
                if (next.done)
                    return { outcome: next.value, sawAuthoritativeTerminal };
                if (next.value.type === 'final' || next.value.type === 'approval_required' || next.value.type === 'error') {
                    sawAuthoritativeTerminal = true;
                }
                yield next.value;
            }
        }
        finally {
            await events.return({ kind: 'stale' });
        }
    }
    async *#executeTerminalCommand(command) {
        if (command.kind === 'emit_terminal') {
            yield toTerminalEvent(command.terminal);
        }
    }
    async #emitTurnStart(input, origin, turnId) {
        if (!this.deps.hookLifecycle || !this.deps.hookEvents)
            return;
        const text = typeof input === 'string' ? input : input.text;
        await this.#emit(this.deps.hookEvents.create('turn.start', {
            origin,
            ...(this.deps.hookEvents.includeUserText ? { userText: text } : {}),
        }, { turnId }));
    }
    async #emitTurnError(error) {
        if (!this.#activeTurnId || !this.deps.hookLifecycle || !this.deps.hookEvents)
            return;
        if (isClassifiedCancellation(error))
            return;
        const message = error instanceof Error ? error.message : String(error);
        await this.#emit(this.deps.hookEvents.create('turn.error', {
            errorCategory: 'unknown',
            safeMessage: message.slice(0, 500),
            recoverable: false,
        }, { turnId: this.#activeTurnId }));
    }
    async #emitTurnEnd(outcome) {
        const turnId = this.#activeTurnId;
        if (!turnId)
            return;
        const terminalKind = outcome.kind;
        const shouldClear = terminalKind !== 'approval_required';
        if (this.deps.hookLifecycle && this.deps.hookEvents) {
            const event = this.deps.hookEvents.create('turn.end', {
                terminalKind,
                duration: Math.max(0, Date.now() - this.#activeTurnStartedAt),
            }, { turnId });
            if (shouldClear) {
                this.#activeTurnId = undefined;
                this.#activeTurnStartedAt = 0;
                this.deps.turnAdapter.setHookTurnId?.(undefined);
            }
            await this.#emit(event);
        }
        else if (shouldClear) {
            this.#activeTurnId = undefined;
            this.#activeTurnStartedAt = 0;
            this.deps.turnAdapter.setHookTurnId?.(undefined);
        }
    }
    async #emit(event) {
        try {
            await this.deps.hookLifecycle?.emit(event);
        }
        catch {
            // Public hooks are passive and fail open.
        }
    }
}
//# sourceMappingURL=turn-coordinator.js.map