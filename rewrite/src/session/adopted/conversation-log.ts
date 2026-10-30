import { ModelSelectionSchema } from '../../../../source/services/settings/model-selection.js';
import {
  validateSettingsBaseline,
  validateMarkedSettings,
  type SessionSettingsInitialized,
} from '../../../../source/services/settings/session-runtime-settings.js';
import { projectNetworkFacts, validateNetworkFact, type NetworkFact } from './network.js';
/**
 * Adopt the source conversation JSONL record boundary for the new session
 * layer. The canonical file remains the only durable session authority;
 * source replay, identity resolution and delta merge stay in source/.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelRef } from '../../model/index.js';
import type { Workspace } from '../../tools/index.js';
import {
  sanitizePendingInteractionDto,
  type PendingInteractionDto,
} from '../../../../source/gateway/interaction-protocol.js';
import {
  SIDECAR_EVENT_TYPES,
  type LogEvent,
  type LogEnvelope,
  type PersistedLogEvent,
  type SessionInitEvent,
} from '../../../../source/services/logging/conversation-log-events.js';
import {
  createConversationLogWriter,
  type AtomicConversationLogWriter,
} from '../../../../source/services/logging/conversation-log-writer.js';
import {
  loadConversationUnscopedForIndex,
  readConversationLogEnvelopesFromDirectory,
  type RestoredState,
} from '../../../../source/services/conversation/conversation-persistence.js';
import {
  replayEvents,
  replayEventsWithRetryTarget,
} from '../../../../source/services/conversation/conversation-replay.js';
import { auditSessionLog } from '../../../../source/services/conversation/session-audit.js';
import {
  decodeLogEnvelope,
  type PersistedLogEnvelope,
} from '../../../../source/services/conversation/conversation-decoder.js';
import type { SessionLog } from '../index.js';

export type ExistingConversationLogEvent = LogEvent;
export type { PendingInteractionDto };
export type SessionBinding = {
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly grantVersion: string;
  readonly fingerprint: string;
};

export type SessionLifecycleFact =
  | {
      readonly type: 'session_bound';
      readonly version: 1;
      readonly workspace: Workspace;
      readonly model: ModelRef;
      readonly binding?: SessionBinding;
    }
  | {
      readonly type: 'session_admitted';
      readonly version: 1;
      readonly clientRequestId: string;
      readonly normalizedBodyHash: string;
      readonly turnId: string;
      readonly disposition: 'started' | 'queued';
      readonly createdAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: 'session_admission_settled';
      readonly version: 1;
      readonly clientRequestId: string;
      readonly turnId: string;
      readonly result: 'accepted' | 'failed' | 'aborted' | 'queue_discarded';
    }
  | {
      readonly type: 'session_turn_started';
      readonly version: 1;
      readonly turnId: string;
      readonly clientRequestId: string | null;
    }
  | {
      readonly type: 'session_turn_ended';
      readonly version: 1;
      readonly turnId: string;
      readonly outcome: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted';
    }
  | {
      readonly type: 'session_interaction_pending';
      readonly version: 1;
      readonly turnId: string;
      readonly interaction: PendingInteractionDto;
      readonly generation: string;
      readonly settleOnRecovery?: 'child_interrupted';
      readonly child?: { readonly agentId: string; readonly role: string };
    }
  | {
      readonly type: 'session_interaction_recovered';
      readonly version: 1;
      readonly turnId: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly generation: string;
      readonly reason: 'daemon_restart';
    }
  | {
      readonly type: 'session_interaction_resolved';
      readonly version: 1;
      readonly turnId: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly generation: string;
      readonly outcome: 'answered' | 'cancelled' | 'expired';
      readonly answer?: {
        readonly choiceId?: string;
        readonly answers?: readonly (string | readonly string[])[];
        readonly rejectionReason?: string;
      };
    }
  | {
      readonly type: 'session_interrupted';
      readonly version: 1;
      readonly turnId: string | null;
      readonly reason: 'daemon_restart' | 'forced_shutdown';
      readonly interruptedAt: string;
    }
  | {
      readonly type: 'session_closed';
      readonly version: 1;
      readonly closedAt: string;
      readonly retentionEligibleAt: string;
    };

export type SessionFact = ExistingConversationLogEvent | SessionLifecycleFact | SessionSettingsInitialized | NetworkFact;
/** Unknown and truncated legacy events are retained verbatim at the decoder boundary. */
export type StoredSessionFact = SessionFact;
export type SessionEventReference = { readonly logId: string; readonly eventId: string };
export type SessionLogEntry = {
  readonly seq: number;
  readonly at: string;
  readonly fact: StoredSessionFact;
  readonly ref: SessionEventReference;
};

const LIFECYCLE_TYPES = new Set([
  'session_settings_initialized',
  'session_network_requested',
  'session_network_resolved',
  'session_bound',
  'session_admitted',
  'session_admission_settled',
  'session_turn_started',
  'session_turn_ended',
  'session_interaction_pending',
  'session_interaction_recovered',
  'session_interaction_resolved',
  'session_interrupted',
  'session_closed',
]);
const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const SHA256 = /^[0-9a-f]{64}$/;
const ADOPTED_USER_TURN_HASH = /^adopted-user-turn-v1:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const isUtcTime = (value: unknown): value is string =>
  typeof value === 'string' && UTC.test(value) && Number.isFinite(Date.parse(value));
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isWorkspace = (value: unknown): value is Workspace =>
  isObject(value) &&
  typeof value['root'] === 'string' &&
  (value['access'] === 'read' || value['access'] === 'read_write') &&
  (value['target'] === 'local' || value['target'] === 'ssh');
const isModel = (value: unknown): value is ModelRef =>
  isObject(value) && typeof value['provider'] === 'string' && typeof value['model'] === 'string';

/** Validate and sanitize lifecycle records at both append and recovery boundaries. */
export function validateSessionFact(value: unknown): asserts value is SessionFact {
  if (!isObject(value) || typeof value['type'] !== 'string')
    throw new Error('session fact must be an object with a type');
  if (!LIFECYCLE_TYPES.has(value['type'])) {
    if (value['truncated'] === true) throw new Error('truncated markers cannot be appended as session facts');
    if (value['type'] === 'session_fact_batch') throw new Error('storage batches cannot be nested as session facts');
    const decoded = decodeLogEnvelope({
      v: 3,
      seq: 1,
      ts: new Date(0).toISOString(),
      logId: 'validate',
      eventId: 'validate',
      event: value,
    });
    if (!decoded) throw new Error(`invalid conversation log fact ${value['type']}`);
    return;
  }
  if (value['version'] !== 1) throw new Error(`invalid ${value['type']} fact version`);
  switch (value['type']) {
    case 'session_settings_initialized':
      validateSettingsBaseline(value);
      return;
    case 'session_network_requested':
    case 'session_network_resolved':
      validateNetworkFact(value);
      return;
    case 'session_bound': {
      if (!isWorkspace(value['workspace']) || !isModel(value['model']))
        throw new Error('invalid session_bound workspace/model');
      const binding = value['binding'];
      if (
        binding !== undefined &&
        (!isObject(binding) ||
          !NON_EMPTY(binding['ownerUserId']) ||
          !NON_EMPTY(binding['workspaceId']) ||
          !NON_EMPTY(binding['grantVersion']) ||
          !NON_EMPTY(binding['fingerprint']))
      )
        throw new Error('invalid session_bound binding');
      return;
    }
    case 'session_admitted':
      if (
        !NON_EMPTY(value['clientRequestId']) ||
        !(
          SHA256.test(String(value['normalizedBodyHash'])) ||
          ADOPTED_USER_TURN_HASH.test(String(value['normalizedBodyHash']))
        ) ||
        !NON_EMPTY(value['turnId']) ||
        !['started', 'queued'].includes(String(value['disposition'])) ||
        !isUtcTime(value['createdAt']) ||
        !isUtcTime(value['expiresAt']) ||
        Date.parse(value['expiresAt']) <= Date.parse(value['createdAt'])
      )
        throw new Error('invalid session_admitted fact');
      return;
    case 'session_admission_settled':
      if (
        !NON_EMPTY(value['clientRequestId']) ||
        !NON_EMPTY(value['turnId']) ||
        !['accepted', 'failed', 'aborted', 'queue_discarded'].includes(String(value['result']))
      )
        throw new Error('invalid session_admission_settled fact');
      return;
    case 'session_turn_started':
      if (!NON_EMPTY(value['turnId']) || !(value['clientRequestId'] === null || NON_EMPTY(value['clientRequestId'])))
        throw new Error('invalid session_turn_started fact');
      return;
    case 'session_turn_ended':
      if (
        !NON_EMPTY(value['turnId']) ||
        !['completed', 'cancelled', 'failed', 'budget_exhausted'].includes(String(value['outcome']))
      )
        throw new Error('invalid session_turn_ended fact');
      return;
    case 'session_interaction_pending': {
      if (!NON_EMPTY(value['turnId']) || !NON_EMPTY(value['generation']))
        throw new Error('invalid session_interaction_pending identity');
      const interaction = sanitizePendingInteractionDto(value['interaction']);
      value['interaction'] = interaction;
      if (value['settleOnRecovery'] !== undefined && value['settleOnRecovery'] !== 'child_interrupted')
        throw new Error('invalid interaction recovery mode');
      if (
        value['child'] !== undefined &&
        (!isObject(value['child']) || !NON_EMPTY(value['child']['agentId']) || !NON_EMPTY(value['child']['role']))
      )
        throw new Error('invalid interaction child metadata');
      return;
    }
    case 'session_interaction_recovered':
      if (
        !NON_EMPTY(value['turnId']) ||
        !NON_EMPTY(value['interactionId']) ||
        !isRevision(value['revision']) ||
        !NON_EMPTY(value['generation']) ||
        value['reason'] !== 'daemon_restart'
      )
        throw new Error('invalid session_interaction_recovered fact');
      return;
    case 'session_interaction_resolved': {
      if (
        !NON_EMPTY(value['turnId']) ||
        !NON_EMPTY(value['interactionId']) ||
        !isRevision(value['revision']) ||
        !NON_EMPTY(value['generation']) ||
        !['answered', 'cancelled', 'expired'].includes(String(value['outcome']))
      )
        throw new Error('invalid session_interaction_resolved fact');
      if (value['answer'] !== undefined) {
        const answer = value['answer'];
        if (
          !isObject(answer) ||
          Object.keys(answer).some((key) => !['choiceId', 'answers', 'rejectionReason'].includes(key))
        )
          throw new Error('invalid interaction answer');
        if (answer['choiceId'] !== undefined && !NON_EMPTY(answer['choiceId']))
          throw new Error('invalid interaction choice');
        if (answer['rejectionReason'] !== undefined && typeof answer['rejectionReason'] !== 'string')
          throw new Error('invalid interaction rejection reason');
        if (
          answer['answers'] !== undefined &&
          (!Array.isArray(answer['answers']) ||
            !answer['answers'].every(
              (item) =>
                typeof item === 'string' || (Array.isArray(item) && item.every((child) => typeof child === 'string')),
            ))
        )
          throw new Error('invalid interaction answers');
      }
      return;
    }
    case 'session_interrupted':
      if (
        !(value['turnId'] === null || NON_EMPTY(value['turnId'])) ||
        !['daemon_restart', 'forced_shutdown'].includes(String(value['reason'])) ||
        !isUtcTime(value['interruptedAt'])
      )
        throw new Error('invalid session_interrupted fact');
      return;
    case 'session_closed':
      if (!isUtcTime(value['closedAt']) || !isUtcTime(value['retentionEligibleAt']))
        throw new Error('invalid session_closed fact');
      return;
  }
}

function validateStoredEntry(entry: PersistedLogEnvelope): SessionLogEntry {
  const fact = entry.event as unknown;
  if (isObject(fact) && typeof fact['type'] === 'string' && LIFECYCLE_TYPES.has(fact['type']))
    validateSessionFact(fact);
  const logId = entry.logId;
  const eventId = entry.eventId;
  if (!NON_EMPTY(logId) || !NON_EMPTY(eventId))
    throw new Error(`conversation event ${entry.seq} has no stable identity`);
  return { seq: entry.seq, at: entry.ts, fact: fact as StoredSessionFact, ref: { logId, eventId } };
}

export type CanonicalSessionLogOptions = {
  readonly root: string;
  readonly id: string;
  readonly metadata: Partial<Omit<SessionInitEvent, 'type' | 'id'>> & { readonly createdAt?: string };
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly binding?: SessionBinding;
  readonly logger: Parameters<typeof createConversationLogWriter>[0]['logger'];
  readonly fileSystem?: Parameters<typeof createConversationLogWriter>[0]['fileSystem'];
};
export type CanonicalSessionLogOpenOptions = Pick<CanonicalSessionLogOptions, 'root' | 'id' | 'logger' | 'fileSystem'>;

/** One canonical JSONL log, with the source writer's lock/liveness rules. */
export class CanonicalSessionLog implements SessionLog {
  readonly id: string;
  readonly root: string;
  readonly #writer: AtomicConversationLogWriter;
  #entries: SessionLogEntry[];
  #appendTail: Promise<void> = Promise.resolve();

  private constructor(id: string, root: string, writer: AtomicConversationLogWriter, entries: SessionLogEntry[]) {
    this.id = id;
    this.root = root;
    this.#writer = writer;
    this.#entries = entries;
  }

  static create(options: CanonicalSessionLogOptions): CanonicalSessionLog {
    const { root, id } = resolveSafeLogPath(options.root, options.id);
    fs.mkdirSync(root, { recursive: true });
    assertCanonicalFile(root, id, false);
    if (fs.existsSync(path.join(root, `${id}.jsonl`))) throw new Error(`conversation ${id} already exists`);
    const writer = createConversationLogWriter({
      sessionId: id,
      dir: root,
      logger: options.logger,
      saveLast: () => undefined,
      fileSystem: options.fileSystem,
    });
    const init: Omit<SessionInitEvent, 'type'> = {
      ...options.metadata,
      id,
      createdAt: options.metadata.createdAt ?? new Date().toISOString(),
    };
    const bindingFact: SessionLifecycleFact = {
      type: 'session_bound',
      version: 1,
      workspace: options.workspace,
      model: options.model,
      ...(options.binding ? { binding: options.binding } : {}),
    };
    validateSessionFact(bindingFact);
    try {
      writer.initBatch(init, [bindingFact]);
      const entries = loadEntries(id, root);
      return new CanonicalSessionLog(id, root, writer, entries);
    } catch (error) {
      void writer.close();
      throw error;
    }
  }

  static open(options: CanonicalSessionLogOpenOptions): CanonicalSessionLog {
    const { root, id } = resolveSafeLogPath(options.root, options.id);
    assertCanonicalFile(root, id, true);
    const entries = loadEntries(id, root);
    const init = entries.find((entry) => entry.fact.type === 'session_init')?.fact as SessionInitEvent | undefined;
    if (!init) throw new Error(`conversation ${id} has no session_init record`);
    const writer = createConversationLogWriter({
      sessionId: id,
      dir: root,
      logger: options.logger,
      saveLast: () => undefined,
      fileSystem: options.fileSystem,
    });
    writer.openExisting({ ...init, id });
    try {
      // Re-read after acquiring the writer lock; the first read was only to
      // obtain source metadata and cannot supply a writable projection.
      return new CanonicalSessionLog(id, root, writer, loadEntries(id, root));
    } catch (error) {
      void writer.close();
      throw error;
    }
  }

  /** Read-only canonical load for list projections; it never takes a lock or repairs a tail. */
  static readOnly(root: string, id: string): readonly SessionLogEntry[] {
    const safe = resolveSafeLogPath(root, id);
    assertCanonicalFile(safe.root, id, true);
    return loadEntries(id, safe.root);
  }

  get lastSeq(): number {
    return this.#entries.at(-1)?.seq ?? 0;
  }
  entries(): readonly SessionLogEntry[] {
    return this.#entries;
  }

  async append(facts: readonly SessionFact[]): Promise<readonly SessionLogEntry[]> {
    const operation = this.#appendTail.then(() => this.#appendNow(facts));
    this.#appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #appendNow(facts: readonly SessionFact[]): Promise<readonly SessionLogEntry[]> {
    if (facts.length === 0) return [];
    for (const fact of facts) {
      validateSessionFact(fact);
      if (fact.type === 'session_bound' && this.#entries.some((entry) => entry.fact.type === 'session_bound')) {
        throw new Error('session_bound is immutable once written');
      }
    }
    validatePendingRevisionSequence([...this.#entries.map((entry) => entry.fact), ...facts]);
    validateSettingsSequence([...this.#entries.map((entry) => entry.fact), ...facts]);
    projectNetworkFacts([...this.#entries.map((entry) => entry.fact), ...facts]);
    const previousSeq = this.lastSeq;
    const sidecars = facts.filter((fact) => SIDECAR_EVENT_TYPES.has(fact.type as LogEvent['type']));
    for (const fact of sidecars) this.#writer.append(fact as LogEvent);
    const durable = facts.filter((fact) => !SIDECAR_EVENT_TYPES.has(fact.type as LogEvent['type']));
    if (durable.length) await this.#writer.appendBatch(durable);
    this.#entries = loadEntries(this.id, this.root);
    return this.#entries.filter((entry) => entry.seq > previousSeq);
  }

  async *read(fromSeq = 0): AsyncIterable<SessionLogEntry> {
    await this.#appendTail;
    for (const entry of this.#entries) if (entry.seq > fromSeq) yield entry;
  }

  async flush(): Promise<void> {
    await this.#appendTail;
    await this.#writer.flush();
  }
  async dispose(): Promise<void> {
    await this.#appendTail;
    await this.#writer.close();
  }
  async deleteFiles(): Promise<void> {
    await this.#appendTail;
    await this.#writer.deleteSessionFiles();
  }
}

function resolveSafeLogPath(inputRoot: string, id: string): { root: string; id: string; file: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('invalid session id');
  const root = path.resolve(inputRoot);
  const file = path.resolve(root, `${id}.jsonl`);
  if (path.dirname(file) !== root) throw new Error('session path escapes conversation directory');
  return { root, id, file };
}

function assertCanonicalFile(root: string, id: string, mustExist: boolean): void {
  const { file } = resolveSafeLogPath(root, id);
  if (!fs.existsSync(root)) {
    if (mustExist) throw new Error(`conversation directory does not exist: ${root}`);
    return;
  }
  const rootReal = fs.realpathSync(root);
  if (path.resolve(rootReal) !== path.resolve(root))
    throw new Error('conversation root must be a canonical directory path');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('session path is not a regular file');
    if (path.dirname(fs.realpathSync(file)) !== rootReal)
      throw new Error('session path escapes conversation directory');
  } catch (error) {
    if (mustExist || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

function loadEntries(id: string, root: string): SessionLogEntry[] {
  const envelopes = readConversationLogEnvelopesFromDirectory(id, root);
  if (!envelopes) throw new Error(`conversation ${id} could not be read`);
  const entries = envelopes.map(validateStoredEntry);
  if (entries.filter((entry) => entry.fact.type === 'session_bound').length > 1) {
    throw new Error(`conversation ${id} has more than one immutable session_bound fact`);
  }
  validatePendingRevisionSequence(entries.map((entry) => entry.fact));
  validateSettingsSequence(entries.map((entry) => entry.fact));
  projectNetworkFacts(entries.map((entry) => entry.fact));
  return entries;
}

function validateSettingsSequence(facts: readonly StoredSessionFact[]): void {
  let bound = false;
  let baseline = false;
  let model: { provider: string; model: string } | undefined;
  for (const fact of facts) {
    if (fact.type === 'session_bound') {
      bound = true;
      model = fact.model;
    }
    if (fact.type === 'settings_changed') {
      if (Object.hasOwn(fact, 'sessionMutation')) {
        validateMarkedSettings(fact as unknown as Record<string, unknown>);
        if (!baseline) throw new Error('settings mutation before baseline');
      }
      if (fact.key === 'agent.modelSelection') {
        const parsed = ModelSelectionSchema.safeParse(fact.value);
        if (parsed.success) model = parsed.data;
      }
      if (fact.key === 'agent.model' && typeof fact.value === 'string' && model)
        model = { ...model, model: fact.value };
      if (fact.key === 'agent.provider' && typeof fact.value === 'string' && model)
        model = { ...model, provider: fact.value };
    }
    if (fact.type === 'session_settings_initialized') {
      validateSettingsBaseline(fact as unknown as Record<string, unknown>);
      if (!bound || baseline || !model || fact.model.provider !== model.provider || fact.model.model !== model.model)
        throw new Error('invalid session settings baseline order or model');
      baseline = true;
    }
  }
}

function validatePendingRevisionSequence(facts: readonly StoredSessionFact[]): void {
  const revisions = new Map<string, number>();
  for (const fact of facts) {
    if (fact.type !== 'session_interaction_pending') continue;
    const key = JSON.stringify([fact.turnId, fact.interaction.interactionId, fact.generation]);
    const previous = revisions.get(key);
    if (previous !== undefined && fact.interaction.revision <= previous) {
      throw new Error('session interaction pending revision must increase for its turn, identity, and generation');
    }
    revisions.set(key, fact.interaction.revision);
  }
}

/** Source's existing decoder/replay path, including provider-native item preservation. */
export function loadCanonicalConversation(
  id: string,
  root: string,
  finalization: 'live' | 'reopened' = 'reopened',
): RestoredState {
  if (finalization === 'live') {
    const envelopes = readConversationLogEnvelopesFromDirectory(id, root);
    if (!envelopes) throw new Error(`conversation ${id} could not be replayed`);
    return replayEvents(envelopes, { finalization });
  }
  const result = loadConversationUnscopedForIndex(id, root);
  if (result.status === 'loaded' || result.status === 'project_mismatch') return result.conversation;
  if (result.status === 'unreadable') {
    throw new Error(`conversation ${id} could not be replayed: ${String(result.error)}`);
  }
  throw new Error(`conversation ${id} is unavailable (${result.status})`);
}

/** Identity is derived by the same canonical replay that validates retry references. */
export function loadCanonicalRetryTarget(id: string, root: string, finalization: 'live' | 'reopened' = 'live') {
  const envelopes = readConversationLogEnvelopesFromDirectory(id, root);
  if (!envelopes) throw new Error(`conversation ${id} could not be replayed`);
  return replayEventsWithRetryTarget(envelopes, { finalization }).retryTarget;
}

/** Source's established interrupted-turn audit; it is observational and never resumes work. */
export function auditCanonicalConversation(id: string, root: string) {
  const envelopes = readConversationLogEnvelopesFromDirectory(id, root);
  if (!envelopes) throw new Error(`conversation ${id} could not be audited`);
  return auditSessionLog(envelopes);
}

export function normalizedBodyHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isObject(input)) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, canonical(input[key])]),
      );
    }
    return input;
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export type AtomicSessionEnvelope = LogEnvelope<SessionFact>;
export type ReadableSourceFact = LogEvent | PersistedLogEvent;
