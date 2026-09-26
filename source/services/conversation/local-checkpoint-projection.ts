import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { isLocalContextSummary } from '../../contracts/provider-input.js';
import { isTruncatedLogEvent, type EventReference } from '../logging/conversation-log-events.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import { projectModelRequestHistory } from './conversation-state-projector.js';
import { repairConversationHistory } from './conversation-history-repair.js';
import { synthesizeHistoryFromAssistantTurn } from './conversation-turn-items.js';

type ProjectionResult =
  | { status: 'no_checkpoint' | 'refused' }
  | { status: 'derived'; history: ProviderInputItem[]; postCheckpointTurnFinalized: boolean };

const refKey = (ref: EventReference): string => JSON.stringify([ref.logId, ref.eventId]);
const envelopeKey = (envelope: PersistedLogEnvelope): string | null =>
  envelope.logId && envelope.eventId ? refKey({ logId: envelope.logId, eventId: envelope.eventId }) : null;
const clone = <T>(value: T): T => structuredClone(value);

/**
 * Rebuilds portable request history from a persisted local checkpoint, its
 * uncovered pre-checkpoint hot tail, and finalized source turns after it. It
 * publishes only when coverage resolves and, when available, the request
 * snapshot exactly matches; unsupported or stale records keep safe replay.
 */
export function deriveLocalCheckpointRequestHistory(
  envelopes: readonly PersistedLogEnvelope[],
  replayedHistory: readonly ProviderInputItem[],
): ProjectionResult {
  let checkpointIndex = -1;
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index]!;
    if (
      !isTruncatedLogEvent(envelope.event) &&
      envelope.event.type === 'context_checkpoint_created' &&
      isLocalContextSummary(envelope.event.item)
    ) {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex < 0) return { status: 'no_checkpoint' };

  const checkpointEnvelope = envelopes[checkpointIndex]!;
  if (isTruncatedLogEvent(checkpointEnvelope.event) || checkpointEnvelope.event.type !== 'context_checkpoint_created') {
    return { status: 'refused' };
  }
  const checkpoint = checkpointEnvelope.event;
  if (!checkpoint.artifactId || checkpoint.sourceRefs.length === 0) return { status: 'refused' };

  const beforeCheckpoint = envelopes.slice(0, checkpointIndex);
  const finalizedTurnIdsBeforeCheckpoint = new Set(
    beforeCheckpoint.flatMap((envelope) =>
      !isTruncatedLogEvent(envelope.event) && envelope.event.type === 'assistant_turn' && envelope.event.turnId
        ? [envelope.event.turnId]
        : [],
    ),
  );
  for (const envelope of beforeCheckpoint) {
    if (
      !isTruncatedLogEvent(envelope.event) &&
      (envelope.event.type === 'assistant_journal_item' || envelope.event.type === 'assistant_journal_delta') &&
      !finalizedTurnIdsBeforeCheckpoint.has(envelope.event.turnId)
    ) {
      // The replay fold owns recovery of an open assistant journal, including
      // tool effects. Until those items have a finalized assistant_turn before
      // the checkpoint, replacing replay history could drop an executed effect.
      return { status: 'refused' };
    }
  }

  const byRef = new Map<string, PersistedLogEnvelope>();
  for (const envelope of envelopes) {
    const key = envelopeKey(envelope);
    if (!key || byRef.has(key)) return { status: 'refused' };
    byRef.set(key, envelope);
  }

  const covered = new Set<string>();
  let lastSourceSeq = -1;
  for (const ref of checkpoint.sourceRefs) {
    const key = refKey(ref);
    const source = byRef.get(key);
    if (covered.has(key) || !source || source.seq >= checkpointEnvelope.seq || source.seq <= lastSourceSeq) {
      return { status: 'refused' };
    }
    if (isTruncatedLogEvent(source.event) || !['user_message', 'assistant_turn'].includes(source.event.type)) {
      return { status: 'refused' };
    }
    covered.add(key);
    lastSourceSeq = source.seq;
  }

  let resetIndex = -1;
  for (let index = 0; index < checkpointIndex; index += 1) {
    const envelope = envelopes[index]!;
    if (!isTruncatedLogEvent(envelope.event) && envelope.event.type === 'session_cleared') resetIndex = index;
  }
  const sourceEnvelopes = envelopes
    .slice(resetIndex + 1, checkpointIndex)
    .filter(
      (envelope) =>
        !isTruncatedLogEvent(envelope.event) && ['user_message', 'assistant_turn'].includes(envelope.event.type),
    );
  const orderedSourceRefs = sourceEnvelopes.map(envelopeKey);
  if (orderedSourceRefs.some((key) => key === null)) return { status: 'refused' };
  const sourceKeys = orderedSourceRefs as string[];
  if (checkpoint.sourceRefs.length > sourceKeys.length) return { status: 'refused' };
  if (checkpoint.sourceRefs.some((ref, index) => refKey(ref) !== sourceKeys[index])) return { status: 'refused' };
  const coldPrefixEnvelopes = sourceEnvelopes.slice(0, checkpoint.sourceRefs.length);
  const hotTailEnvelopes = sourceEnvelopes.slice(checkpoint.sourceRefs.length);
  const completeTurns = (turnEvents: readonly PersistedLogEnvelope[]): boolean => {
    let hasUser = false;
    let hasAssistant = false;
    for (const envelope of turnEvents) {
      if (isTruncatedLogEvent(envelope.event)) return false;
      if (envelope.event.type === 'user_message') {
        if (hasUser && !hasAssistant) return false;
        hasUser = true;
        hasAssistant = false;
      } else if (envelope.event.type === 'assistant_turn') {
        if (!hasUser) return false;
        hasAssistant = true;
      }
    }
    return hasUser && hasAssistant;
  };
  const hasTrailingCurrentUser = hotTailEnvelopes.at(-1)?.event.type === 'user_message';
  const completedHotTail = hasTrailingCurrentUser ? hotTailEnvelopes.slice(0, -1) : hotTailEnvelopes;
  const completedHotUsers = completedHotTail.filter((envelope) => envelope.event.type === 'user_message').length;
  // The production planner always protects its two newest user turns. When
  // replay sees the automatic-compaction boundary, one is the current open
  // user and only the preceding protected turn is complete. Between turns,
  // both protected turns are complete. Never accept a shorter suffix than
  // that planner-defined boundary.
  const minimumCompletedHotUsers = hasTrailingCurrentUser ? 1 : 2;
  if (
    !completeTurns(coldPrefixEnvelopes) ||
    !completeTurns(completedHotTail) ||
    completedHotUsers < minimumCompletedHotUsers
  ) {
    return { status: 'refused' };
  }

  const retracted = new Set<string>();
  for (const envelope of envelopes) {
    if (isTruncatedLogEvent(envelope.event)) return { status: 'refused' };
    if (envelope.event.type === 'events_retracted') {
      for (const ref of envelope.event.refs) retracted.add(refKey(ref));
    }
    if (envelope.event.type === 'undo' || envelope.event.type === 'session_cleared') return { status: 'refused' };
  }
  if (sourceKeys.some((key) => retracted.has(key))) return { status: 'refused' };

  const coveredUsers = [...covered].filter((key) => byRef.get(key)?.event.type === 'user_message').length;
  const coveredAssistants = [...covered].filter((key) => byRef.get(key)?.event.type === 'assistant_turn').length;
  if (coveredUsers === 0 || coveredAssistants < coveredUsers) return { status: 'refused' };

  const history: ProviderInputItem[] = [clone(checkpoint.item)];
  let hasPostCheckpointSnapshot = false;
  const afterCheckpoint = envelopes.slice(checkpointIndex + 1);
  const finalizedTurnIds = new Set(
    afterCheckpoint.flatMap((envelope) =>
      !isTruncatedLogEvent(envelope.event) && envelope.event.type === 'assistant_turn' && envelope.event.turnId
        ? [envelope.event.turnId]
        : [],
    ),
  );
  for (const envelope of afterCheckpoint) {
    if (
      !isTruncatedLogEvent(envelope.event) &&
      (envelope.event.type === 'assistant_journal_item' || envelope.event.type === 'assistant_journal_delta') &&
      (!envelope.event.turnId || !finalizedTurnIds.has(envelope.event.turnId))
    ) {
      return { status: 'refused' };
    }
  }
  const appendSourceEvent = (envelope: PersistedLogEnvelope): boolean => {
    if (isTruncatedLogEvent(envelope.event)) return false;
    if (envelope.event.type === 'user_message') {
      history.push({ role: 'user', type: 'message', content: envelope.event.message.text ?? '' });
    } else if (envelope.event.type === 'assistant_turn') {
      history.splice(0, history.length, ...synthesizeHistoryFromAssistantTurn(history, envelope.event.turn));
    }
    return true;
  };
  for (const envelope of hotTailEnvelopes) if (!appendSourceEvent(envelope)) return { status: 'refused' };
  for (const envelope of afterCheckpoint) {
    if (isTruncatedLogEvent(envelope.event)) return { status: 'refused' };
    if (envelope.event.type === 'user_message') {
      if (!appendSourceEvent(envelope)) return { status: 'refused' };
    } else if (envelope.event.type === 'assistant_turn') {
      hasPostCheckpointSnapshot ||= envelope.event.providerHistory !== undefined;
      if (!appendSourceEvent(envelope)) return { status: 'refused' };
    }
  }
  if (history.some((item) => item.providerOpaque !== undefined)) return { status: 'refused' };
  if (repairConversationHistory(history).repaired) return { status: 'refused' };

  if (hasPostCheckpointSnapshot) {
    const observed = projectModelRequestHistory(replayedHistory);
    if (JSON.stringify(history) !== JSON.stringify(observed)) return { status: 'refused' };
  }
  return {
    status: 'derived',
    history,
    postCheckpointTurnFinalized: afterCheckpoint.some(
      (envelope) => !isTruncatedLogEvent(envelope.event) && envelope.event.type === 'assistant_turn',
    ),
  };
}
