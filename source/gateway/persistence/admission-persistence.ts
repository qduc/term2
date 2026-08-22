import crypto from 'node:crypto';
import type { LogEvent } from '../../services/logging/conversation-log-events.js';
import {
  GatewayPersistenceError,
  type AdmissionRecord,
  type AdmissionResult,
  type DurableEventCandidate,
} from './contracts.js';
import type { GatewayCriticalPersistence } from './session-persistence.js';
import { GatewaySessionIndex } from './session-index.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function normalizedBodyHash(body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(body)), 'utf8')
    .digest('hex');
}

export type AdmissionLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replayed'; readonly record: AdmissionRecord }
  | { readonly kind: 'conflict'; readonly record: AdmissionRecord };

export type GatewayMessageAdmissionRuntime = {
  prepareMessage(
    input: unknown,
    ids: { turnId: string; clientRequestId: string },
  ): Promise<
    | { kind: 'prepared'; leaseId: string; turnId: string }
    | { kind: 'rejected'; reason: 'busy' | 'queue_full' | 'closed' }
  >;
  commitMessage(leaseId: string): Promise<void>;
  cancelPreparedMessage(leaseId: string): Promise<void>;
};

export type GatewayAdmissionResult =
  | { readonly kind: 'accepted'; readonly record: AdmissionRecord; readonly replayed: false }
  | { readonly kind: 'replayed'; readonly record: AdmissionRecord; readonly replayed: true }
  | { readonly kind: 'rejected'; readonly reason: 'busy' | 'queue_full' | 'closed' };

export class GatewayAdmissionPersistence {
  readonly #index: GatewaySessionIndex;
  readonly #leaseTtlMs: number;

  constructor(index: GatewaySessionIndex, options: { leaseTtlMs?: number } = {}) {
    this.#index = index;
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  lookup(ownerUserId: string, sessionId: string, clientRequestId: string, body: unknown): AdmissionLookup {
    const record = this.#index.admission(ownerUserId, sessionId, clientRequestId);
    if (!record) return { kind: 'new' };
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

  prepare(input: {
    ownerUserId: string;
    sessionId: string;
    clientRequestId: string;
    body: unknown;
    turnId: string;
  }): AdmissionRecord {
    const existing = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
    if (existing.kind === 'replayed') return existing.record;
    if (existing.kind === 'conflict')
      throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
    const now = new Date();
    const record: AdmissionRecord = {
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
    } catch (error) {
      const retry = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
      if (retry.kind === 'replayed') return retry.record;
      throw error;
    }
  }

  async admit(input: {
    ownerUserId: string;
    sessionId: string;
    clientRequestId: string;
    body: unknown;
    turnId: string;
    runtime: GatewayMessageAdmissionRuntime;
    persistence: GatewayCriticalPersistence;
    term2Fact: LogEvent;
    acceptedEvent: DurableEventCandidate;
    /** Runs after accepted facts are durable and before runtime execution starts. */
    beforeCommit?: () => Promise<void>;
  }): Promise<GatewayAdmissionResult> {
    const lookup = this.lookup(input.ownerUserId, input.sessionId, input.clientRequestId, input.body);
    if (lookup.kind === 'conflict')
      throw new GatewayPersistenceError('conflict', 'idempotency key has a different body');
    if (lookup.kind === 'replayed') return { kind: 'replayed', record: lookup.record, replayed: true };
    const prepared = await input.runtime.prepareMessage(input.body, {
      turnId: input.turnId,
      clientRequestId: input.clientRequestId,
    });
    if (prepared.kind !== 'prepared') return prepared;
    let record: AdmissionRecord;
    try {
      record = this.prepare(input);
    } catch (error) {
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
    } catch (error) {
      const durable = this.#index.admission(input.ownerUserId, input.sessionId, input.clientRequestId);
      if (!durable || durable.phase === 'prepared') {
        try {
          await input.runtime.cancelPreparedMessage(prepared.leaseId);
        } catch {
          // The runtime's own interruption/read-only state is the recovery signal.
        }
      }
      if (durable && (durable.state === 'accepted' || durable.state === 'committed')) {
        this.markTerminal(durable.ownerUserId, durable.sessionId, durable.clientRequestId, 'failed');
      }
      throw error;
    }
  }

  async accept(input: {
    record: AdmissionRecord;
    persistence: GatewayCriticalPersistence;
    term2Fact: LogEvent;
    acceptedEvent: DurableEventCandidate;
  }): Promise<AdmissionRecord> {
    const current = this.#index.admission(
      input.record.ownerUserId,
      input.record.sessionId,
      input.record.clientRequestId,
    );
    if (!current) throw new GatewayPersistenceError('not_found', 'prepared admission not found');
    if (current.state === 'accepted' || current.state === 'committed') return current;
    if (current.state !== 'prepared') throw new GatewayPersistenceError('conflict', 'admission is no longer prepared');
    const transcript = await input.persistence.appendTranscriptCritical(input.term2Fact);
    this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
      phase: 'transcript_written',
      transcriptChecksum: transcript.checksum,
    });
    const journal = await input.persistence.appendJournalCritical(input.acceptedEvent);
    this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
      phase: 'journal_written',
      journalChecksum: journal.checksum,
    });
    if (
      !input.persistence.verifyTranscriptFact(input.term2Fact, transcript.checksum) ||
      !input.persistence.verifyJournalEvent(input.acceptedEvent, journal.checksum)
    ) {
      throw new GatewayPersistenceError('readonly', 'admission durable facts failed checksum validation');
    }
    return this.#index.updateAdmission(current.ownerUserId, current.sessionId, current.clientRequestId, {
      state: 'accepted',
      result: 'accepted',
      phase: 'committed',
      transcriptChecksum: transcript.checksum,
      journalChecksum: journal.checksum,
    });
  }

  markTerminal(
    ownerUserId: string,
    sessionId: string,
    clientRequestId: string,
    result: AdmissionResult,
  ): AdmissionRecord {
    const current = this.#index.admission(ownerUserId, sessionId, clientRequestId);
    if (!current) throw new GatewayPersistenceError('not_found', 'admission not found');
    if (current.state !== 'accepted' && current.state !== 'committed') {
      return this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
        state: 'rejected',
        result: result === 'accepted' ? 'failed' : result,
      });
    }
    return this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
      state: 'terminal',
      result,
      phase: 'committed',
    });
  }

  reconcile(
    ownerUserId: string,
    sessionId: string,
    clientRequestId: string,
    callbacks: {
      cancelPrepared: (turnId: string) => Promise<void>;
      verifyTranscript?: (record: AdmissionRecord) => Promise<boolean>;
      verifyJournal?: (record: AdmissionRecord) => Promise<boolean>;
      repairAcceptedEvent?: (record: AdmissionRecord) => Promise<void>;
    },
  ): Promise<AdmissionRecord | null> {
    const record = this.#index.admission(ownerUserId, sessionId, clientRequestId);
    if (!record) return Promise.resolve(null);
    const commit = () =>
      this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
        state: 'accepted',
        result: 'accepted',
        phase: 'committed',
      });
    if (record.state === 'prepared') {
      if (callbacks.verifyTranscript && record.transcriptChecksum) {
        return callbacks.verifyTranscript(record).then((present) => {
          if (!present) {
            return callbacks.cancelPrepared(record.turnId).then(() =>
              this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
                state: 'rejected',
                result: 'failed',
              }),
            );
          }
          if (!callbacks.repairAcceptedEvent)
            throw new GatewayPersistenceError('readonly', 'accepted event repair is unavailable');
          return callbacks.repairAcceptedEvent(record).then(commit);
        });
      }
      return callbacks.cancelPrepared(record.turnId).then(() =>
        this.#index.updateAdmission(ownerUserId, sessionId, clientRequestId, {
          state: 'rejected',
          result: 'failed',
        }),
      );
    }
    if (record.phase === 'transcript_written') {
      if (!callbacks.verifyTranscript || !callbacks.repairAcceptedEvent)
        throw new GatewayPersistenceError('readonly', 'transcript admission fact cannot be verified');
      return callbacks.verifyTranscript(record).then((valid) => {
        if (!valid) throw new GatewayPersistenceError('readonly', 'transcript admission fact is corrupt');
        return callbacks.repairAcceptedEvent!(record).then(commit);
      });
    }
    if (record.phase === 'journal_written') {
      if (!callbacks.verifyTranscript || !callbacks.verifyJournal)
        throw new GatewayPersistenceError('readonly', 'accepted admission facts cannot be verified');
      return Promise.all([callbacks.verifyTranscript(record), callbacks.verifyJournal(record)]).then(
        ([transcript, journal]) => {
          if (!transcript || !journal)
            throw new GatewayPersistenceError('readonly', 'accepted admission fact checksum mismatch');
          return commit();
        },
      );
    }
    if (record.state === 'accepted' || record.state === 'committed' || record.state === 'terminal')
      return Promise.resolve(record);
    return Promise.resolve(record);
  }
}
