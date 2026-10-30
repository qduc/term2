import crypto from 'node:crypto';
import { GatewayPersistenceError, TERMINAL_AGENT_EVENT_TYPES } from './contracts.js';
import { createSessionPersistence } from './session-persistence.js';
import { GatewaySessionIndex } from './session-index.js';
export function computeBindingFingerprint(binding) {
    const targetKind = binding.canonicalRoot.startsWith('ssh:') ? 'ssh' : 'local';
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({
        salt: 'term2-gateway-binding-v1',
        canonicalRoot: binding.canonicalRoot,
        access: binding.access,
        targetKind,
        grantVersion: binding.grantVersion,
    }), 'utf8')
        .digest('hex');
}
/** Owns the one admission/attachment ordering used by a gateway session. */
export class GatewayPersistenceCoordinator {
    #layout;
    #index;
    constructor(layout, index = new GatewaySessionIndex(layout)) {
        this.#layout = layout;
        this.#index = index;
    }
    get index() {
        return this.#index;
    }
    get layout() {
        return this.#layout;
    }
    assertBinding(record, binding) {
        if (record.bindingFingerprint !== computeBindingFingerprint(binding)) {
            throw new GatewayPersistenceError('readonly', 'session binding fingerprint mismatch; operator recovery required');
        }
    }
    async open(binding, options = {}) {
        const now = options.createdAt ?? new Date().toISOString();
        const existing = this.#index.get(binding.sessionId);
        let created = false;
        if (!existing) {
            this.#index.create({
                id: binding.sessionId,
                ownerUserId: binding.ownerUserId,
                workspaceId: binding.workspaceId,
                grantVersion: String(binding.grantVersion),
                bindingFingerprint: computeBindingFingerprint(binding),
                status: 'initializing',
                createdAt: now,
                updatedAt: now,
            });
            created = true;
        }
        else {
            this.assertBinding(existing, binding);
            if (existing.ownerUserId !== binding.ownerUserId || existing.workspaceId !== binding.workspaceId) {
                throw new GatewayPersistenceError('owner_mismatch', 'session not found');
            }
            if (existing.status === 'closed')
                throw new GatewayPersistenceError('conflict', 'session is closed');
        }
        let persistence;
        try {
            persistence = createSessionPersistence({
                layout: this.#layout,
                ownerUserId: binding.ownerUserId,
                workspaceId: binding.workspaceId,
                sessionId: binding.sessionId,
                createdAt: existing?.createdAt ?? now,
                transcriptGeneration: existing?.transcriptGeneration,
            });
            if (created) {
                await persistence.critical.appendCritical({ type: 'session_init', id: binding.sessionId, createdAt: now }, { sessionId: binding.sessionId, type: 'session_created', payload: {} });
            }
            const highWater = persistence.journal.highWater();
            this.#index.update(binding.sessionId, {
                status: created ? 'idle' : existing.status,
                lastAppendedSequence: highWater.lastAppendedSequence,
                lastPublishedSequence: highWater.lastPublishedSequence,
                firstRetainedEventSequence: highWater.firstRetainedEventSequence,
                projectionSequence: highWater.projectionSequence,
                updatedAt: new Date().toISOString(),
            });
            await persistence.interactionCheckpoint.recover(persistence.journal);
            await this.reconcileStartup(binding, persistence, existing?.status);
            return { record: this.#index.get(binding.sessionId), persistence };
        }
        catch (error) {
            try {
                await persistence?.close();
            }
            catch {
                // Preserve the original admission error; the directory remains evidence.
            }
            try {
                this.#index.update(binding.sessionId, {
                    status: 'interrupted',
                    recoveryWarning: 'session persistence initialization failed',
                    interruptedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    activeTurnId: null,
                });
            }
            catch {
                // Preserve the initialization failure if the index itself is unhealthy.
            }
            throw error instanceof GatewayPersistenceError
                ? error
                : new GatewayPersistenceError('readonly', 'session persistence initialization failed');
        }
    }
    async reconcileStartup(binding, persistence, priorStatus) {
        const record = this.#index.getForOwner(binding.ownerUserId, binding.sessionId);
        const events = persistence.journal.events();
        const trailing = events.at(-1);
        const hasInFlightFact = trailing &&
            [
                'user_message_accepted',
                'assistant_started',
                'tool_started',
                'approval_required',
                'interaction_updated',
            ].includes(trailing.type);
        if (['running', 'awaiting_interaction'].includes(priorStatus ?? record.status) || hasInFlightFact) {
            this.#index.update(binding.sessionId, {
                status: 'interrupted',
                activeTurnId: null,
                interruptedAt: new Date().toISOString(),
                recoveryWarning: 'session interrupted during startup reconciliation',
                updatedAt: new Date().toISOString(),
            });
        }
        for (const admission of this.#index.listAdmissions(binding.ownerUserId, binding.sessionId)) {
            if (!['accepted', 'committed'].includes(admission.state))
                continue;
            const alreadyRejected = events.some((event) => event.type === 'user_message_rejected' && event.payload.turnId === admission.turnId);
            const started = events.some((event) => event.type === 'assistant_started' && event.payload.turnId === admission.turnId);
            if (alreadyRejected || started)
                continue;
            const terminalEvent = events.find((event) => TERMINAL_AGENT_EVENT_TYPES.has(event.type) && event.payload.turnId === admission.turnId);
            if (terminalEvent) {
                this.#index.updateAdmission(binding.ownerUserId, binding.sessionId, admission.clientRequestId, {
                    state: 'terminal',
                    result: terminalEvent.type === 'turn_completed'
                        ? 'accepted'
                        : terminalEvent.type === 'turn_failed'
                            ? 'failed'
                            : 'aborted',
                });
                continue;
            }
            await persistence.journal.append({
                sessionId: binding.sessionId,
                type: 'user_message_rejected',
                payload: {
                    turnId: admission.turnId,
                    clientRequestId: admission.clientRequestId,
                    reason: 'queue_discarded',
                },
            }, { durability: 'critical' });
            this.#index.updateAdmission(binding.ownerUserId, binding.sessionId, admission.clientRequestId, {
                state: 'rejected',
                result: 'queue_discarded',
            });
        }
    }
    async close(sessionId, status = 'closed') {
        const record = this.#index.get(sessionId);
        if (!record)
            throw new GatewayPersistenceError('not_found', 'session not found');
        this.#index.update(sessionId, {
            status,
            activeTurnId: status === 'closed' || status === 'interrupted' ? null : record.activeTurnId,
            updatedAt: new Date().toISOString(),
        });
    }
    /** Record a durable marker before a provider-owned close is abandoned. */
    markForcedShutdown(sessionId) {
        const record = this.#index.get(sessionId);
        if (!record || record.status === 'closed')
            return;
        this.#index.update(sessionId, {
            status: 'interrupted',
            activeTurnId: null,
            interruptedAt: new Date().toISOString(),
            recoveryWarning: 'session forcibly interrupted during gateway shutdown',
            updatedAt: new Date().toISOString(),
        });
    }
    closeIndex() {
        this.#index.close();
    }
}
//# sourceMappingURL=coordinator.js.map