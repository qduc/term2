import { issueInputSurgeApproval } from '../input-surge-approval.js';
import { injectSkillIntoTurn } from '../../types/user-turn.js';
/**
 * Owns the policy that decides whether a user turn is admitted now or needs a
 * confirmation. The UI renders the current confirmation and translates its
 * answer; it never owns the staged turn, bypass capability, or admission order.
 */
export class ConversationAdmissionWorkflow {
    #deps;
    #pending = null;
    #nextId = 0;
    #listeners = new Set();
    constructor(deps) {
        this.#deps = { ...deps, now: deps.now ?? Date.now };
    }
    getSnapshot() {
        return this.#pending;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    submit(turn, options = {}) {
        if (this.#pending) {
            return { kind: 'confirmation_required', confirmation: this.#pending };
        }
        return this.#attempt(turn, this.#admissionOptions(options));
    }
    resolve(id, decision) {
        const pending = this.#pending;
        if (!pending || pending.id !== id) {
            return { kind: 'stale' };
        }
        // Consume synchronously: a duplicate keypress cannot resolve a later
        // confirmation while the original decision is awaiting a send.
        this.#pending = null;
        this.#notify();
        if (decision === 'decline') {
            return { kind: 'declined', turn: pending.turn };
        }
        if (pending.kind === 'surge') {
            return this.#admit(pending.turn, {
                ...pending.options,
                inputSurgeApproval: issueInputSurgeApproval(pending.turn.skill ? injectSkillIntoTurn(pending.turn) : pending.turn),
            });
        }
        return this.#admit(pending.turn, pending.options);
    }
    #attempt(turn, options) {
        const surge = this.#deps.conversation.previewInputSurge(turn);
        if (surge.action === 'block') {
            const confirmation = {
                id: this.#createId(),
                kind: 'surge',
                turn,
                reason: surge.reason || 'Input surge detected',
                options,
            };
            this.#setPending(confirmation);
            this.#deps.logger.debug('Input surge warning shown', {
                eventType: 'input_surge_warning_shown',
                category: 'provider',
                reason: surge.reason,
                stats: surge.stats,
                previousStats: surge.previousStats,
            });
            return { kind: 'confirmation_required', confirmation };
        }
        if (!this.#deps.conversation.isQueueActive()) {
            const large = this.#deps.conversation.previewLargeUncachedInput(turn, this.#deps.now());
            if (large.action === 'warn') {
                const confirmation = {
                    id: this.#createId(),
                    kind: 'large_uncached',
                    turn,
                    estimatedTokens: large.estimatedTokens,
                    options,
                };
                this.#setPending(confirmation);
                this.#deps.logger.debug('Large uncached input warning shown', {
                    eventType: 'large_uncached_input_warning_shown',
                    category: 'provider',
                    estimatedTokens: large.estimatedTokens,
                    estimatedBytes: large.estimatedBytes,
                    reasons: large.reasons,
                });
                return { kind: 'confirmation_required', confirmation };
            }
        }
        return this.#admit(turn, options);
    }
    #admit(turn, options) {
        this.#deps.history.addMessage(turn);
        try {
            return { kind: 'submitted', completion: this.#deps.send(turn, options) };
        }
        catch (error) {
            return { kind: 'submitted', completion: Promise.reject(error) };
        }
    }
    #createId() {
        this.#nextId += 1;
        return `admission-${this.#nextId}`;
    }
    #admissionOptions(options) {
        return options.busyMode ? { busyMode: options.busyMode } : {};
    }
    #setPending(confirmation) {
        this.#pending = confirmation;
        this.#notify();
    }
    #notify() {
        for (const listener of this.#listeners)
            listener();
    }
}
//# sourceMappingURL=conversation-admission-workflow.js.map