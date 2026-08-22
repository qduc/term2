import fs from 'node:fs';
import path from 'node:path';
import { decodeLogEnvelope, type PersistedLogEnvelope } from '../../services/conversation/conversation-decoder.js';
import { replayEvents, type RestoredState } from '../../services/conversation/conversation-replay.js';
import type { ConversationService } from '../../services/conversation/conversation-service.js';
import {
  GatewayPersistenceError,
  type AgentEventEnvelope,
  type GatewaySessionRecord,
  type ReplayLiveSubscription,
  type PersistenceHighWater,
} from './contracts.js';
import { GatewayEventJournalImpl } from './event-journal.js';
import { GatewaySessionIndex } from './session-index.js';
import { fsyncDirectory, type GatewayStorageLayout } from './storage.js';
import type { PendingInteractionDto } from '../interaction-protocol.js';

export type { PendingInteractionDto } from '../interaction-protocol.js';

export type InteractionProjection =
  | null
  | { readonly state: 'pending'; readonly interaction: PendingInteractionDto; readonly turnId: string }
  | {
      readonly state: 'recovered';
      readonly interaction: PendingInteractionDto;
      readonly turnId: string;
      readonly resolvable: false;
      readonly reason: 'daemon_restart' | 'forced_shutdown' | 'persistence_recovery';
    };

export type SessionProjectionSource = {
  readonly session: GatewaySessionRecord;
  readonly latestSequence: number;
  readonly earliestReplayableSequence: number;
  readonly projectionSequence: number;
  readonly transcript: RestoredState | null;
  readonly interaction: InteractionProjection;
  readonly resolvedInteractionIds: ReadonlySet<string>;
  subscribeFrom(after: number | null, listener: (event: AgentEventEnvelope) => void): ReplayLiveSubscription;
};

function quarantine(pathname: string, bytes: Buffer, suffix: string): void {
  const directory = path.join(path.dirname(pathname), 'corruption');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, `${path.basename(pathname)}.${Date.now()}.${suffix}`), bytes, { mode: 0o600 });
}

function rewriteAndSync(pathname: string, content: string): void {
  fs.writeFileSync(pathname, content, { mode: 0o600 });
  const fd = fs.openSync(pathname, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(pathname));
}

function decodeLines(
  pathname: string,
  repairFinalTail: boolean,
): { envelopes: PersistedLogEnvelope[]; warning: string | null } {
  const data = fs.readFileSync(pathname, 'utf8');
  const lines = data.split('\n');
  const envelopes: PersistedLogEnvelope[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isLastWithoutNewline = index === lines.length - 1 && line.length > 0;
    if (!line.trim()) continue;
    try {
      const envelope = decodeLogEnvelope(JSON.parse(line));
      if (!envelope || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) {
        throw new GatewayPersistenceError('corrupt', 'term2 transcript contains an invalid sequence');
      }
      envelopes.push(envelope);
    } catch (error) {
      if (repairFinalTail && isLastWithoutNewline) {
        quarantine(pathname, Buffer.from(line, 'utf8'), 'tail');
        const valid = envelopes.map((envelope) => JSON.stringify(envelope) + '\n').join('');
        rewriteAndSync(pathname, valid);
        return { envelopes, warning: `${path.basename(pathname)} torn tail quarantined and repaired` };
      }
      throw error instanceof GatewayPersistenceError
        ? error
        : new GatewayPersistenceError('corrupt', `${path.basename(pathname)} contains invalid JSON`);
    }
  }
  return { envelopes, warning: null };
}

function readTerm2Envelopes(directory: string, expectedSessionId?: string): PersistedLogEnvelope[] {
  const canonicalPath = path.join(directory, 'term2.jsonl');
  if (!fs.existsSync(canonicalPath)) return [];
  const canonical = decodeLines(canonicalPath, true);
  const all = [...canonical.envelopes];
  const deltaPath = path.join(directory, 'term2.deltas');
  if (fs.existsSync(deltaPath)) {
    try {
      all.push(...decodeLines(deltaPath, false).envelopes);
    } catch (error) {
      if (error instanceof GatewayPersistenceError) {
        quarantine(deltaPath, fs.readFileSync(deltaPath), 'corrupt');
        // A corrupt sidecar only loses an unsettled turn. The canonical prefix remains replayable.
      } else {
        throw new GatewayPersistenceError('corrupt', 'term2 delta sidecar is corrupt');
      }
    }
  }
  all.sort((a, b) => a.seq - b.seq);
  let previous = 0;
  for (const envelope of all) {
    if (envelope.seq <= previous)
      throw new GatewayPersistenceError('corrupt', 'term2 transcript sequence is duplicated');
    previous = envelope.seq;
    if (
      expectedSessionId &&
      envelope.event.type === 'session_init' &&
      'id' in envelope.event &&
      envelope.event.id !== expectedSessionId
    ) {
      throw new GatewayPersistenceError('corrupt', 'term2 transcript belongs to another session');
    }
  }
  return all;
}

function interactionFromJournal(journal: GatewayEventJournalImpl): InteractionProjection {
  let projection: InteractionProjection = null;
  const resolvedInteractionIds = new Set<string>();
  for (const event of journal.events()) {
    if (event.type === 'interaction_resolved' && typeof event.payload.interactionId === 'string') {
      resolvedInteractionIds.add(event.payload.interactionId);
    }
    if (event.type === 'approval_required' || event.type === 'interaction_updated') {
      projection = {
        state: 'recovered',
        interaction:
          event.payload.interaction && typeof event.payload.interaction === 'object'
            ? (event.payload.interaction as PendingInteractionDto)
            : ({} as PendingInteractionDto),
        turnId: String(event.payload.turnId),
        resolvable: false,
        reason: 'daemon_restart',
      };
    }
    const recoveredInteractionId =
      event.type === 'interaction_recovered' &&
      event.payload.interaction &&
      typeof event.payload.interaction === 'object' &&
      typeof (event.payload.interaction as Record<string, unknown>).interactionId === 'string'
        ? ((event.payload.interaction as Record<string, unknown>).interactionId as string)
        : null;
    if (event.type === 'interaction_recovered' && !resolvedInteractionIds.has(recoveredInteractionId ?? '')) {
      projection = {
        state: 'recovered',
        interaction:
          event.payload.interaction && typeof event.payload.interaction === 'object'
            ? (event.payload.interaction as PendingInteractionDto)
            : ({} as PendingInteractionDto),
        turnId: String(event.payload.turnId),
        resolvable: false,
        reason:
          event.payload.reason === 'forced_shutdown' || event.payload.reason === 'persistence_recovery'
            ? event.payload.reason
            : 'daemon_restart',
      };
    }
    if (
      event.type === 'interaction_resolved' ||
      event.type === 'turn_completed' ||
      event.type === 'turn_aborted' ||
      event.type === 'turn_failed'
    ) {
      projection = null;
    }
  }
  return projection;
}

export function hydrateTranscript(directory: string, expectedSessionId?: string): RestoredState | null {
  const envelopes = readTerm2Envelopes(directory, expectedSessionId);
  if (envelopes.length === 0) return null;
  return replayEvents(envelopes);
}

export function hydrateConversationService(
  service: ConversationService,
  directory: string,
  expectedSessionId?: string,
): RestoredState | null {
  const restored = hydrateTranscript(directory, expectedSessionId);
  if (!restored) return null;
  service.importState({
    history: restored.history,
    previousResponseId: restored.previousResponseId,
    toolLedger: restored.toolLedger,
    updatedAt: restored.updatedAt,
  });
  return restored;
}

export async function createSessionProjectionSource(options: {
  index: GatewaySessionIndex;
  layout: GatewayStorageLayout;
  ownerUserId: string;
  sessionId: string;
  journal: GatewayEventJournalImpl;
  liveInteraction?: () => Promise<{
    state: 'pending';
    interaction: PendingInteractionDto;
    turnId: string;
  } | null> | null;
}): Promise<SessionProjectionSource> {
  const session = options.index.getForOwner(options.ownerUserId, options.sessionId);
  const highWater: PersistenceHighWater = options.journal.highWater();
  let interaction = interactionFromJournal(options.journal);
  const resolvedInteractionIds = new Set<string>();
  for (const event of options.journal.events()) {
    if (event.type === 'interaction_resolved' && typeof event.payload.interactionId === 'string') {
      resolvedInteractionIds.add(event.payload.interactionId);
    }
  }
  if (options.liveInteraction) {
    try {
      const live = await options.liveInteraction();
      if (live) interaction = live;
    } catch {
      // A disposed runtime is represented by the non-resolvable recovery projection.
    }
  }
  const directory = options.layout.existingSessionPath(session.ownerUserId, session.workspaceId, session.id);
  if (!directory) throw new GatewayPersistenceError('not_found', 'session persistence directory not found');
  return {
    session,
    latestSequence: highWater.lastPublishedSequence,
    earliestReplayableSequence: highWater.firstRetainedEventSequence,
    projectionSequence: highWater.projectionSequence,
    transcript: hydrateTranscript(directory, session.id),
    interaction,
    resolvedInteractionIds,
    subscribeFrom: (after, listener) => options.journal.subscribeFrom(after, listener, session.transcriptGeneration),
  };
}
