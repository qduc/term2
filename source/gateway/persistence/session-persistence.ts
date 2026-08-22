import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ILoggingService } from '../../services/service-interfaces.js';
import type { LogEvent } from '../../services/logging/conversation-log-events.js';
import {
  CONVERSATION_FSYNC_EVENTS,
  createConversationLogWriter,
  type ConversationLogWriter,
} from '../../services/logging/conversation-log-writer.js';
import { decodeLogEnvelope } from '../../services/conversation/conversation-decoder.js';
import { GatewayPersistenceError, type DurableEventCandidate } from './contracts.js';
import { createGatewayEventJournal, type GatewayEventJournalImpl } from './event-journal.js';
import { InteractionCheckpointStore } from './interaction-checkpoint.js';
import type { GatewayStorageLayout } from './storage.js';

const noopLogger: ILoggingService = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  security: () => undefined,
  setCorrelationId: () => undefined,
  getCorrelationId: () => 'gateway-persistence',
  clearCorrelationId: () => undefined,
};

function checksum(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function journalFactChecksum(event: DurableEventCandidate): string {
  return checksum({ sessionId: event.sessionId, type: event.type, payload: event.payload });
}

export interface GatewayCriticalPersistence {
  appendTranscriptCritical(term2Fact: LogEvent): Promise<{ checksum: string; fsynced: true }>;
  appendJournalCritical(event: DurableEventCandidate): Promise<{ id: number; checksum: string; fsynced: true }>;
  appendCritical(term2Fact: LogEvent, event: DurableEventCandidate): Promise<{ id: number; fsynced: true }>;
  verifyTranscriptFact(term2Fact: LogEvent, expectedChecksum?: string): boolean;
  verifyJournalEvent(event: DurableEventCandidate, expectedChecksum?: string): boolean;
  flush(): Promise<void>;
  assertHealthy(): void;
  readonly failure: Error | null;
}

export class GatewayCriticalPersistenceImpl implements GatewayCriticalPersistence {
  readonly #writer: ConversationLogWriter;
  readonly #journal: GatewayEventJournalImpl;
  #failure: Error | null = null;

  constructor(writer: ConversationLogWriter, journal: GatewayEventJournalImpl) {
    this.#writer = writer;
    this.#journal = journal;
  }

  get failure(): Error | null {
    return this.#failure;
  }

  assertHealthy(): void {
    if (this.#failure) throw new GatewayPersistenceError('journal_unhealthy', this.#failure.message);
    this.#journal.assertHealthy();
  }

  #assertCriticalFact(term2Fact: LogEvent): void {
    if (!CONVERSATION_FSYNC_EVENTS.has(term2Fact.type)) {
      throw new GatewayPersistenceError('conflict', `term2 fact ${term2Fact.type} is not a critical fsync boundary`);
    }
  }

  async appendTranscriptCritical(term2Fact: LogEvent): Promise<{ checksum: string; fsynced: true }> {
    this.assertHealthy();
    this.#assertCriticalFact(term2Fact);
    try {
      this.#writer.append(term2Fact);
      return { checksum: checksum(term2Fact), fsynced: true };
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      throw new GatewayPersistenceError('journal_unhealthy', 'critical transcript append failed');
    }
  }

  async appendJournalCritical(event: DurableEventCandidate): Promise<{ id: number; checksum: string; fsynced: true }> {
    this.assertHealthy();
    try {
      const occurredAt = event.occurredAt ?? new Date().toISOString();
      const normalized = { ...event, occurredAt };
      const appended = await this.#journal.append(normalized, { durability: 'critical' });
      if (!appended.fsynced) throw new Error('critical journal append was not fsynced');
      return { id: appended.id, checksum: journalFactChecksum(event), fsynced: true };
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      throw new GatewayPersistenceError('journal_unhealthy', 'critical journal append failed');
    }
  }

  async appendCritical(term2Fact: LogEvent, event: DurableEventCandidate): Promise<{ id: number; fsynced: true }> {
    await this.appendTranscriptCritical(term2Fact);
    const appended = await this.appendJournalCritical(event);
    return { id: appended.id, fsynced: true };
  }

  verifyTranscriptFact(term2Fact: LogEvent, expectedChecksum?: string): boolean {
    const file = path.join(this.#journal.directory, 'term2.jsonl');
    if (!fs.existsSync(file)) return false;
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          const envelope = decodeLogEnvelope(JSON.parse(line));
          return envelope && checksum(envelope.event) === (expectedChecksum ?? checksum(term2Fact));
        });
    } catch {
      return false;
    }
  }

  verifyJournalEvent(event: DurableEventCandidate, expectedChecksum?: string): boolean {
    const wanted = expectedChecksum ?? journalFactChecksum(event);
    return this.#journal.events().some(
      (candidate) =>
        journalFactChecksum({
          sessionId: candidate.sessionId,
          type: candidate.type,
          payload: candidate.payload,
        }) === wanted,
    );
  }

  async flush(): Promise<void> {
    this.assertHealthy();
    try {
      await this.#writer.flush();
      await this.#journal.flush();
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      throw new GatewayPersistenceError('journal_unhealthy', 'critical persistence flush failed');
    }
  }
}

export type SessionPersistenceHandle = {
  readonly directory: string;
  readonly writer: ConversationLogWriter;
  readonly journal: GatewayEventJournalImpl;
  readonly critical: GatewayCriticalPersistenceImpl;
  readonly interactionCheckpoint: InteractionCheckpointStore;
  close(): Promise<void>;
};

export type CreateSessionPersistenceOptions = {
  layout: GatewayStorageLayout;
  ownerUserId: string;
  workspaceId: string;
  sessionId: string;
  createdAt?: string;
  logger?: ILoggingService;
  transcriptGeneration?: number;
};

export function createSessionPersistence(options: CreateSessionPersistenceOptions): SessionPersistenceHandle {
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
        let failure: unknown;
        try {
          await critical.flush();
        } catch (error) {
          failure = error;
        }
        journal.close();
        try {
          await writer.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    };
  } catch (error) {
    void writer.close().catch(() => undefined);
    throw error;
  }
}
