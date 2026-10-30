import crypto from 'node:crypto';
import { GatewayPersistenceError, } from './contracts.js';
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
}
export function normalizedBodyHash(body) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}
export class GatewayAdmissionPersistence {
    #index;
    #leaseTtlMs;
    constructor(index, options = {}) {
        this.#index = index;
        this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    }
    lookup(ownerUserId, sessionId, clientRequestId, body) {
        const record = this.#index.admission(ownerUserId, sessionId, clientRequestId);
        if (!record)
            return { kind: 'new' };
        if (Date.parse(record.expiresAt) <= Date.now()) {
            this.#index.deleteAdmission(ownerUserId, sessionId, clientRequestId);
            return { kind: 'new' };
        }
        if (!['accepted', 'committed', 'terminal'].includes(record.state)) {
            this.#index.deleteAdmission(ownerUserId, sessionId, clientRequestId);
            return { kind: 'new' };
        }
        return record.normalizedBodyHash === normalizedBodyHash(body)
            ? { kind: 'replayed', record }
            : { kind: 'conflict', record };
    }
    prepare(input) {
        const existing = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
        if (existing.kind === 'replayed')
            return existing.record;
        if (existing.kind === 'conflict')
            throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
        const now = new Date();
        const record = {
            ownerUserId: input.ownerUserId,
            sessionId: input.sessionId,
            clientRequestId: input.clientRequestId,
            normalizedBodyHash: normalizedBodyHash(input.body),
            turnId: input.turnId,
            state: 'prepared',
            phase: 'prepared',
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.#leaseTtlMs).toISOString(),
        };
        try {
            this.#index.insertAdmission(record);
            return record;
        }
        catch (error) {
            const retry = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
            if (retry.kind === 'replayed')
                return retry.record;
            throw error;
        }
    }
    async admit(input) {
        const lookup = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
        if (lookup.kind === 'conflict')
            throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
        if (lookup.kind === 'replayed')
            return { kind: 'replayed', record: lookup.record, replayed: true };
        const prepared = await input.runtime.prepareMessage(input.body, {
            turnId: input.turnId,
            clientRequestId: input.clientRequestId,
        });
        if (prepared.kind !== 'prepared')
            return prepared;
        let record;
        try {
            record = this.prepare(input);
        }
        catch (error) {
            await input.runtime.cancelPreparedMessage(prepared.leaseId);
            throw error;
        }
        try {
            record = await this.accept({
                record,
                persistence: input.persistence,
                term2Fact: input.term2Fact,
                acceptedEvent: input.acceptedEvent,
            });
            await input.beforeCommit?.();
            await input.runtime.commitMessage(prepared.leaseId);
            return { kind: 'accepted', record, replayed: false };
        }
        catch (error) {
            const durable = this.#index.admission(input.ownerUserId, input.sessionId, input.clientRequestId);
            if (!durable || durable.phase === 'prepared') {
                try {
                    await input.runtime.cancelPreparedMessage(prepared.leaseId);
                }
                catch {
                    // The runtime's own interruption/read-only state is the recovery signal.
                }
            }
            if (durable && (durable.state === 'accepted' || durable.state === 'committed')) {
                this.markTerminal(durable.ownerUserId, durable.sessionId, durable.clientRequestId, 'failed');
            }
            throw error;
        }
    }
    async accept(input) {
        const current = this.#index.admission(input.record.ownerUserId, input.record.sessionId, input.record.clientRequestId);
        if (!current)
            throw new GatewayPersistenceError('not_found', 'prepared admission not found');
        if (current.state === 'accepted' || current.state === 'committed')
            return current;
        if (current.state !== 'prepared')
            throw new GatewayPersistenceError('conflict', 'admission is no longer prepared');
        let transcriptChecksum;
        if (input.term2Fact) {
            const transcript = await input.persistence.appendTranscriptCritical(input.term2Fact);
            transcriptChecksum = transcript.checksum;
            this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
                phase: 'transcript_written',
                transcriptChecksum: transcript.checksum,
            });
        }
        const journal = await input.persistence.appendJournalCritical(input.acceptedEvent);
        this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
            phase: 'journal_written',
            journalChecksum: journal.checksum,
        });
        if ((input.term2Fact &&
            transcriptChecksum &&
            !input.persistence.verifyTranscriptFact(input.term2Fact, transcriptChecksum)) ||
            !input.persistence.verifyJournalEvent(input.acceptedEvent, journal.checksum)) {
            throw new GatewayPersistenceError('readonly', 'admission durable facts failed checksum validation');
        }
        return this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
            state: 'accepted',
            result: 'accepted',
            phase: 'committed',
            ...(transcriptChecksum ? { transcriptChecksum } : {}),
            journalChecksum: journal.checksum,
        });
    }
    markTerminal(ownerUserId, sessionId, clientRequestId, result, turnId) {
        const current = this.#index.admission(ownerUserId, sessionId, clientRequestId);
        if (!current)
            throw new GatewayPersistenceError('not_found', 'admission not found');
        if (current.state !== 'accepted' && current.state !== 'committed') {
            return this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
                state: 'rejected',
                result: result === 'accepted' ? 'failed' : result,
                ...(turnId !== undefined ? { turnId } : {}),
            });
        }
        return this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
            state: 'terminal',
            result,
            phase: 'committed',
            ...(turnId !== undefined ? { turnId } : {}),
        });
    }
    reconcile(ownerUserId, sessionId, clientRequestId, callbacks) {
        const record = this.#index.admission(ownerUserId, sessionId, clientRequestId);
        if (!record)
            return Promise.resolve(null);
        const commit = () => this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
            state: 'accepted',
            result: 'accepted',
            phase: 'committed',
        });
        if (record.state === 'prepared') {
            if (callbacks.verifyTranscript && record.transcriptChecksum) {
                return callbacks.verifyTranscript(record).then((present) => {
                    if (!present) {
                        return callbacks.cancelPrepared(record.turnId).then(() => this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
                            state: 'rejected',
                            result: 'failed',
                        }));
                    }
                    if (!callbacks.repairAcceptedEvent)
                        throw new GatewayPersistenceError('readonly', 'accepted event repair is unavailable');
                    return callbacks.repairAcceptedEvent(record).then(commit);
                });
            }
            return callbacks.cancelPrepared(record.turnId).then(() => this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
                state: 'rejected',
                result: 'failed',
            }));
        }
        if (record.phase === 'transcript_written') {
            if (!callbacks.verifyTranscript || !callbacks.repairAcceptedEvent)
                throw new GatewayPersistenceError('readonly', 'transcript admission fact cannot be verified');
            return callbacks.verifyTranscript(record).then((valid) => {
                if (!valid)
                    throw new GatewayPersistenceError('readonly', 'transcript admission fact is corrupt');
                return callbacks.repairAcceptedEvent(record).then(commit);
            });
        }
        if (record.phase === 'journal_written') {
            if (!callbacks.verifyJournal)
                throw new GatewayPersistenceError('readonly', 'accepted admission facts cannot be verified');
            const verifications = [callbacks.verifyJournal(record)];
            if (record.transcriptChecksum) {
                if (!callbacks.verifyTranscript)
                    throw new GatewayPersistenceError('readonly', 'accepted admission facts cannot be verified');
                verifications.push(callbacks.verifyTranscript(record));
            }
            return Promise.all(verifications).then((results) => {
                if (results.some((valid) => !valid))
                    throw new GatewayPersistenceError('readonly', 'accepted admission fact checksum mismatch');
                return commit();
            });
        }
        if (record.state === 'accepted' || record.state === 'committed' || record.state === 'terminal')
            return Promise.resolve(record);
        return Promise.resolve(record);
    }
}
//# sourceMappingURL=admission-persistence.js.map