import fs from 'node:fs';
import path from 'node:path';
import {
  GatewayPersistenceError,
  type AgentEventEnvelope,
  type DurableEventCandidate,
  type GatewayEventJournal,
  type PersistenceHighWater,
  type ReplayLiveSubscription,
  FROZEN_AGENT_EVENT_TYPES,
} from './contracts.js';
import { fsyncDirectory } from './storage.js';

const MAX_EVENT_BYTES = 256 * 1024;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'ownerUserId',
  'projectPath',
  'canonicalRoot',
  'sshHost',
  'sshTargetId',
  'credentials',
  'apiKey',
  'rawInterruption',
  'path',
  'cwd',
  'root',
  'stack',
  'authorization',
  'previousResponseId',
]);
const PATH_KEYS = new Set(['path', 'cwd', 'root', 'canonicalRoot', 'projectPath']);
const CREDENTIAL_KEYS = new Set([
  'credential',
  'credentials',
  'token',
  'secret',
  'password',
  'apiKey',
  'authorization',
]);
const FROZEN_EVENT_TYPE_SET = new Set<string>(FROZEN_AGENT_EVENT_TYPES);

function assertSafePayload(value: unknown, depth = 0): void {
  if (depth > 8) throw new GatewayPersistenceError('corrupt', 'event payload nesting is too deep');
  if (typeof value === 'string') {
    if (value.length > 32_000 || value.includes('\u0000'))
      throw new GatewayPersistenceError('corrupt', 'event payload is unsafe');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new GatewayPersistenceError('corrupt', 'event payload array is too large');
    for (const item of value) assertSafePayload(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key))
        throw new GatewayPersistenceError('corrupt', `event payload contains ${key}`);
      if (CREDENTIAL_KEYS.has(key) || (typeof child === 'string' && /^Bearer\s+|^sk-[A-Za-z0-9]/.test(child)))
        throw new GatewayPersistenceError('corrupt', `event payload contains credential material`);
      if (PATH_KEYS.has(key) && typeof child === 'string' && /^(?:\/(?:[^/]|$)|[A-Za-z]:[\\/])/.test(child))
        throw new GatewayPersistenceError('corrupt', `event payload contains an absolute path`);
      assertSafePayload(child, depth + 1);
    }
  }
}

function fsyncFile(fd: number): void {
  fs.fsyncSync(fd);
}

function atomicCheckpoint(pathname: string, value: PersistenceHighWater): void {
  const temporary = `${pathname}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  const fd = fs.openSync(temporary, 'r');
  try {
    fsyncFile(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, pathname);
  fsyncDirectory(path.dirname(pathname));
}

export type GatewayEventJournalOptions = {
  sessionId: string;
  directory: string;
  maxEventBytes?: number;
  transcriptGeneration?: number;
};

export class GatewayEventJournalImpl implements GatewayEventJournal {
  readonly #sessionId: string;
  readonly #directory: string;
  readonly #eventsPath: string;
  readonly #checkpointPath: string;
  readonly #maxEventBytes: number;
  readonly #transcriptGeneration: number;
  readonly #listeners = new Set<(event: AgentEventEnvelope) => void>();
  #events: AgentEventEnvelope[] = [];
  #lastAppendedSequence = 0;
  #lastPublishedSequence = 0;
  #firstRetainedEventSequence = 1;
  #projectionSequence = 0;
  #failure: Error | null = null;
  #closed = false;
  #repairWarning: string | null = null;

  constructor(options: GatewayEventJournalOptions) {
    this.#sessionId = options.sessionId;
    this.#directory = options.directory;
    this.#eventsPath = path.join(options.directory, 'events.jsonl');
    this.#checkpointPath = path.join(options.directory, 'event-checkpoint.json');
    this.#maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
    this.#transcriptGeneration = options.transcriptGeneration ?? 1;
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.#load();
  }

  #load(): void {
    try {
      let checkpointLastAppended = 0;
      if (fs.existsSync(this.#checkpointPath)) {
        const checkpoint = JSON.parse(fs.readFileSync(this.#checkpointPath, 'utf8')) as Partial<PersistenceHighWater>;
        if (Number.isSafeInteger(checkpoint.firstRetainedEventSequence) && checkpoint.firstRetainedEventSequence! > 0) {
          this.#firstRetainedEventSequence = checkpoint.firstRetainedEventSequence!;
        }
        if (Number.isSafeInteger(checkpoint.projectionSequence))
          this.#projectionSequence = checkpoint.projectionSequence!;
        if (
          checkpoint.lastAppendedSequence !== undefined &&
          (!Number.isSafeInteger(checkpoint.lastAppendedSequence) || checkpoint.lastAppendedSequence < 0)
        ) {
          throw new GatewayPersistenceError('corrupt', 'journal checkpoint sequence is invalid');
        }
        checkpointLastAppended = checkpoint.lastAppendedSequence ?? 0;
        this.#lastAppendedSequence = checkpointLastAppended;
      }
      if (!fs.existsSync(this.#eventsPath)) return;
      const data = fs.readFileSync(this.#eventsPath, 'utf8');
      const lines = data.split('\n');
      const parsed: AgentEventEnvelope[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const isLastWithoutNewline = index === lines.length - 1 && line.length > 0;
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AgentEventEnvelope;
          this.#validateStoredEvent(event, parsed.length > 0 ? parsed[parsed.length - 1]!.id : 0);
          parsed.push(event);
        } catch (error) {
          if (isLastWithoutNewline) {
            this.#quarantineTail(Buffer.from(line, 'utf8'));
            const valid = parsed.length ? parsed.map((event) => JSON.stringify(event) + '\n').join('') : '';
            fs.writeFileSync(this.#eventsPath, valid, { mode: 0o600 });
            const fd = fs.openSync(this.#eventsPath, 'r');
            try {
              fsyncFile(fd);
            } finally {
              fs.closeSync(fd);
            }
            fsyncDirectory(this.#directory);
            this.#repairWarning = 'journal torn tail quarantined and repaired';
            break;
          }
          throw error instanceof GatewayPersistenceError
            ? error
            : new GatewayPersistenceError('corrupt', 'journal contains invalid JSON');
        }
      }
      this.#events = parsed;
      const lastRecordId = parsed.at(-1)?.id ?? 0;
      if (parsed.length > 0 && checkpointLastAppended > lastRecordId) {
        throw new GatewayPersistenceError('corrupt', 'journal checkpoint is ahead of its records');
      }
      this.#lastAppendedSequence = Math.max(checkpointLastAppended, lastRecordId);
      this.#lastPublishedSequence = this.#lastAppendedSequence;
      if (parsed.length > 0 && this.#firstRetainedEventSequence > lastRecordId) {
        throw new GatewayPersistenceError('corrupt', 'journal retained range is ahead of its records');
      }
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      if (error instanceof GatewayPersistenceError) throw error;
      throw new GatewayPersistenceError('corrupt', 'gateway event journal is corrupt');
    }
  }

  #quarantineTail(bytes: Buffer): void {
    const directory = path.join(this.#directory, 'corruption');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `events.${Date.now()}.tail`), bytes, { mode: 0o600 });
  }

  #validateStoredEvent(event: AgentEventEnvelope, previousId: number): void {
    if (
      !event ||
      event.schemaVersion !== 1 ||
      event.sessionId !== this.#sessionId ||
      !Number.isSafeInteger(event.id) ||
      event.id <= previousId
    ) {
      throw new GatewayPersistenceError('corrupt', 'journal sequence or session identity is invalid');
    }
    if (
      typeof event.type !== 'string' ||
      !FROZEN_EVENT_TYPE_SET.has(event.type) ||
      typeof event.occurredAt !== 'string' ||
      !event.payload ||
      typeof event.payload !== 'object'
    ) {
      throw new GatewayPersistenceError('corrupt', 'journal event shape is invalid');
    }
    assertSafePayload(event.payload);
  }

  get repairWarning(): string | null {
    return this.#repairWarning;
  }

  get transcriptGeneration(): number {
    return this.#transcriptGeneration;
  }

  assertHealthy(): void {
    if (this.#closed) throw new GatewayPersistenceError('readonly', 'event journal is closed');
    if (this.#failure) throw new GatewayPersistenceError('journal_unhealthy', this.#failure.message);
  }

  async append(
    event: DurableEventCandidate,
    options: { durability: 'critical' | 'stream' },
  ): Promise<{ id: number; fsynced: boolean }> {
    this.assertHealthy();
    try {
      if (event.sessionId !== this.#sessionId)
        throw new GatewayPersistenceError('corrupt', 'event belongs to another session');
      if (!FROZEN_EVENT_TYPE_SET.has(event.type))
        throw new GatewayPersistenceError('conflict', 'event type is outside the frozen v1 allowlist');
      if (event.type !== 'session_created' && typeof event.payload.turnId !== 'string') {
        throw new GatewayPersistenceError('corrupt', 'turn-scoped event is missing turnId');
      }
      assertSafePayload(event.payload);
      const envelope: AgentEventEnvelope = {
        schemaVersion: 1,
        id: this.#lastAppendedSequence + 1,
        sessionId: this.#sessionId,
        type: event.type,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        payload: event.payload,
      };
      const line = JSON.stringify(envelope) + '\n';
      if (Buffer.byteLength(line, 'utf8') > this.#maxEventBytes)
        throw new GatewayPersistenceError('corrupt', 'event exceeds persistence bound');
      const fd = fs.openSync(this.#eventsPath, 'a', 0o600);
      try {
        fs.writeSync(fd, line);
        if (options.durability === 'critical') fsyncFile(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.#events.push(envelope);
      this.#lastAppendedSequence = envelope.id;
      atomicCheckpoint(this.#checkpointPath, this.highWater());
      this.#lastPublishedSequence = envelope.id;
      for (const listener of [...this.#listeners]) {
        try {
          listener(envelope);
        } catch {
          // A subscriber cannot make a durable append fail.
        }
      }
      atomicCheckpoint(this.#checkpointPath, this.highWater());
      return { id: envelope.id, fsynced: options.durability === 'critical' };
    } catch (error) {
      if (error instanceof GatewayPersistenceError && error.code !== 'journal_unhealthy') throw error;
      this.#failure = error instanceof Error ? error : new Error(String(error));
      throw new GatewayPersistenceError('journal_unhealthy', 'event journal append failed');
    }
  }

  async flush(): Promise<void> {
    this.assertHealthy();
    const fd = fs.openSync(this.#eventsPath, 'a');
    try {
      fsyncFile(fd);
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      throw new GatewayPersistenceError('journal_unhealthy', 'event journal flush failed');
    } finally {
      fs.closeSync(fd);
    }
    atomicCheckpoint(this.#checkpointPath, this.highWater());
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get directory(): string {
    return this.#directory;
  }

  events(): readonly AgentEventEnvelope[] {
    return this.#events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  highWater(): PersistenceHighWater {
    return {
      lastAppendedSequence: this.#lastAppendedSequence,
      lastPublishedSequence: this.#lastPublishedSequence,
      firstRetainedEventSequence: this.#firstRetainedEventSequence,
      projectionSequence: this.#projectionSequence,
    };
  }

  setProjectionSequence(sequence: number): void {
    this.assertHealthy();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.#lastAppendedSequence) {
      throw new GatewayPersistenceError('conflict', 'projection sequence is invalid');
    }
    this.#projectionSequence = sequence;
    atomicCheckpoint(this.#checkpointPath, this.highWater());
  }

  subscribeFrom(
    after: number | null,
    listener: (event: AgentEventEnvelope) => void,
    expectedTranscriptGeneration?: number,
  ): ReplayLiveSubscription {
    const highWater = this.#lastPublishedSequence;
    if (this.#failure) {
      return {
        kind: 'reload_required',
        reason: 'journal_unhealthy',
        firstRetainedEventSequence: this.#firstRetainedEventSequence,
        latestSequence: highWater,
      };
    }
    if (expectedTranscriptGeneration !== undefined && expectedTranscriptGeneration !== this.#transcriptGeneration) {
      return {
        kind: 'reload_required',
        reason: 'generation_mismatch',
        firstRetainedEventSequence: this.#firstRetainedEventSequence,
        latestSequence: highWater,
      };
    }
    const cursor = after ?? highWater;
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new GatewayPersistenceError('cursor_invalid', 'event cursor is invalid');
    if (after !== null && cursor < this.#firstRetainedEventSequence - 1) {
      return {
        kind: 'reload_required',
        reason: 'cursor_compacted',
        firstRetainedEventSequence: this.#firstRetainedEventSequence,
        latestSequence: highWater,
      };
    }
    if (cursor > highWater) {
      return {
        kind: 'reload_required',
        reason: 'sequence_gap',
        firstRetainedEventSequence: this.#firstRetainedEventSequence,
        latestSequence: highWater,
      };
    }
    const replay = after === null ? [] : this.#events.filter((event) => event.id > cursor && event.id <= highWater);
    const wrapped = (event: AgentEventEnvelope) => {
      if (event.id > highWater) listener(event);
    };
    this.#listeners.add(wrapped);
    return {
      kind: 'subscribed',
      replay,
      replayHighWater: highWater,
      firstRetainedEventSequence: this.#firstRetainedEventSequence,
      unsubscribe: () => this.#listeners.delete(wrapped),
    };
  }

  compactThrough(sequence: number): void {
    this.assertHealthy();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.#lastPublishedSequence) {
      throw new GatewayPersistenceError('conflict', 'compact sequence is invalid');
    }
    this.#events = this.#events.filter((event) => event.id > sequence);
    this.#firstRetainedEventSequence = this.#events[0]?.id ?? this.#lastAppendedSequence + 1;
    const contents = this.#events.map((event) => JSON.stringify(event) + '\n').join('');
    fs.writeFileSync(this.#eventsPath, contents, { mode: 0o600 });
    const fd = fs.openSync(this.#eventsPath, 'r');
    try {
      fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(this.#directory);
    atomicCheckpoint(this.#checkpointPath, this.highWater());
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }
}

export function createGatewayEventJournal(options: GatewayEventJournalOptions): GatewayEventJournalImpl {
  return new GatewayEventJournalImpl(options);
}
