import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONVERSATION_FSYNC_EVENTS, createConversationLogWriter, } from '../../services/logging/conversation-log-writer.js';
import { decodeLogEnvelope } from '../../services/conversation/conversation-decoder.js';
import { GatewayPersistenceError } from './contracts.js';
import { createGatewayEventJournal } from './event-journal.js';
import { InteractionCheckpointStore } from './interaction-checkpoint.js';
const noopLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    security: () => undefined,
    setCorrelationId: () => undefined,
    getCorrelationId: () => 'gateway-persistence',
    clearCorrelationId: () => undefined,
};
function checksum(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function journalFactChecksum(event) {
    return checksum({ sessionId: event.sessionId, type: event.type, payload: event.payload });
}
export class GatewayCriticalPersistenceImpl {
    #writer;
    #journal;
    #failure = null;
    constructor(writer, journal) {
        this.#writer = writer;
        this.#journal = journal;
    }
    get failure() {
        return this.#failure;
    }
    assertHealthy() {
        if (this.#failure)
            throw new GatewayPersistenceError('journal_unhealthy', this.#failure.message);
        this.#journal.assertHealthy();
    }
    #assertCriticalFact(term2Fact) {
        if (!CONVERSATION_FSYNC_EVENTS.has(term2Fact.type)) {
            throw new GatewayPersistenceError('conflict', `term2 fact ${term2Fact.type} is not a critical fsync boundary`);
        }
    }
    async appendTranscriptCritical(term2Fact) {
        this.assertHealthy();
        this.#assertCriticalFact(term2Fact);
        try {
            this.#writer.append(term2Fact);
            return { checksum: checksum(term2Fact), fsynced: true };
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            throw new GatewayPersistenceError('journal_unhealthy', 'critical transcript append failed');
        }
    }
    async appendJournalCritical(event) {
        this.assertHealthy();
        try {
            const occurredAt = event.occurredAt ?? new Date().toISOString();
            const normalized = { ...event, occurredAt };
            const appended = await this.#journal.append(normalized, { durability: 'critical' });
            if (!appended.fsynced)
                throw new Error('critical journal append was not fsynced');
            return { id: appended.id, checksum: journalFactChecksum(event), fsynced: true };
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            throw new GatewayPersistenceError('journal_unhealthy', 'critical journal append failed');
        }
    }
    async appendCritical(term2Fact, event) {
        await this.appendTranscriptCritical(term2Fact);
        const appended = await this.appendJournalCritical(event);
        return { id: appended.id, fsynced: true };
    }
    verifyTranscriptFact(term2Fact, expectedChecksum) {
        const file = path.join(this.#journal.directory, 'term2.jsonl');
        if (!fs.existsSync(file))
            return false;
        try {
            return fs
                .readFileSync(file, 'utf8')
                .split('\n')
                .filter(Boolean)
                .some((line) => {
                const envelope = decodeLogEnvelope(JSON.parse(line));
                return envelope && checksum(envelope.event) === (expectedChecksum ?? checksum(term2Fact));
            });
        }
        catch {
            return false;
        }
    }
    verifyJournalEvent(event, expectedChecksum) {
        const wanted = expectedChecksum ?? journalFactChecksum(event);
        return this.#journal.events().some((candidate) => journalFactChecksum({
            sessionId: candidate.sessionId,
            type: candidate.type,
            payload: candidate.payload,
        }) === wanted);
    }
    async flush() {
        this.assertHealthy();
        try {
            await this.#writer.flush();
            await this.#journal.flush();
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
            throw new GatewayPersistenceError('journal_unhealthy', 'critical persistence flush failed');
        }
    }
}
export function createSessionPersistence(options) {
    const directory = options.layout.sessionPath(options.ownerUserId, options.workspaceId, options.sessionId);
    const writer = createConversationLogWriter({
        sessionId: 'term2',
        dir: directory,
        logger: options.logger ?? noopLogger,
        // Gateway index discovery replaces the CLI last.json mechanism.
        saveLast: () => undefined,
    });
    try {
        writer.init({ id: options.sessionId, createdAt: options.createdAt ?? new Date().toISOString() });
        const journal = createGatewayEventJournal({
            sessionId: options.sessionId,
            directory,
            transcriptGeneration: options.transcriptGeneration,
        });
        const critical = new GatewayCriticalPersistenceImpl(writer, journal);
        const interactionCheckpoint = new InteractionCheckpointStore(directory);
        return {
            directory,
            writer,
            journal,
            critical,
            interactionCheckpoint,
            async close() {
                let failure;
                try {
                    await critical.flush();
                }
                catch (error) {
                    failure = error;
                }
                journal.close();
                try {
                    await writer.close();
                }
                catch (error) {
                    failure ??= error;
                }
                if (failure)
                    throw failure;
            },
        };
    }
    catch (error) {
        void writer.close().catch(() => undefined);
        throw error;
    }
}
//# sourceMappingURL=session-persistence.js.map