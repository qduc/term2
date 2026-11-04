import type { TurnId } from '../engine/index.js';
import type { Item } from '../model/index.js';
import type { bindDirectCapabilities } from './direct-capabilities.js';
import type { TurnRequest } from './direct-types.js';
import type { Fact } from './facts.js';
import { ConversationGeneration, withNotice } from './conversation-generation.js';
import type { ConversationJournal } from './conversation-journal.js';
import { admitConversationTurn } from './conversation-turn.js';

/** Admit the raw turn before consuming notices and prepare its model-only decoration. */
export function prepareConversationNotice(
  turnId: TurnId,
  request: TurnRequest,
  planned:
    | {
        readonly accepted?: true;
        readonly silent?: true;
        readonly facts: readonly Fact[];
        readonly compaction?: true;
        readonly retryNotice?: { readonly messageId: Item['id']; readonly text: string };
        readonly history?: readonly Item[];
      }
    | undefined,
  snapshotHistory: readonly Item[],
  journal: ConversationJournal,
  capabilities: ReturnType<typeof bindDirectCapabilities>,
  generation: ConversationGeneration,
) {
  // Resolve without consuming until durable admission succeeds.
  const hasProfileInput = !planned?.compaction && request.input.some((item) => item.type === 'user_message');
  const notice = generation.notice(request.notice, false, hasProfileInput);
  const modelInput = admitConversationTurn(turnId, request, planned, journal, capabilities, notice);
  if (hasProfileInput || (planned?.retryNotice && generation.notice(undefined) === planned.retryNotice.text)) {
    // A resumed retry can deliver the pending startup notice itself. Never
    // consume a different pending transition on an unrelated retry.
    generation.notice(undefined, true);
  }
  const rawHistory = planned?.history ?? snapshotHistory;
  // Legacy keeps a notice on the message it decorated in every later request. History stays raw; the turn's
  // recorded notice is applied again each time a request is built.
  const recorded = recordedNotices(journal.facts, journal.openedAt);
  let modelHistory: readonly Item[] = rawHistory.map((item) => {
    const text = item.type === 'user_message' ? recorded.get(item.id) : undefined;
    return text ? withNotice([item], text)[0]! : item;
  });
  if (planned?.retryNotice && !recorded.has(planned.retryNotice.messageId)) {
    let index = modelHistory.length - 1;
    while (index >= 0 && modelHistory[index]?.id !== planned.retryNotice.messageId) index--;
    if (index >= 0) {
      modelHistory = [...modelHistory];
      (modelHistory as Item[])[index] = withNotice([modelHistory[index]!], planned.retryNotice.text)[0]!;
    }
  }
  const sentInput = notice ? withNotice(modelInput, notice) : modelInput;
  return { notice, modelInput, rawHistory, modelHistory, sentInput };
}

/**
 * Each decorated turn's notice, by the user message it was applied to (the turn's first; a retry's is its source
 * turn's). Only turns this process started: legacy's resumed history is raw.
 */
function recordedNotices(facts: readonly Fact[], openedAt: number): ReadonlyMap<string, string> {
  const firstMessage = new Map<string, string>();
  const notices = new Map<string, string>();
  facts.forEach((fact, index) => {
    if (fact.type !== 'turn_started') return;
    const first = fact.retryContext
      ? firstMessage.get(fact.retryContext.sourceTurnId)
      : fact.input.find((item) => item.type === 'user_message')?.id;
    if (first) firstMessage.set(fact.turnId, first);
    if (index >= openedAt && fact.requestNotice && first && !notices.has(first)) notices.set(first, fact.requestNotice);
  });
  return notices;
}
