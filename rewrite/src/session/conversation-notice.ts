import type { TurnId } from '../engine/index.js';
import type { Item } from '../model/index.js';
import type { bindDirectCapabilities } from './direct-capabilities.js';
import type { TurnRequest } from './direct-types.js';
import type { Fact } from './facts.js';
import { ConversationGeneration } from './conversation-generation.js';
import { withNotice } from './direct-input-notice.js';
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
  persistentNotice?: string,
) {
  // Resolve without consuming until durable admission succeeds.
  const hasProfileInput = !planned?.compaction && request.input.some((item) => item.type === 'user_message');
  const notice = generation.notice(request.notice, false, hasProfileInput);
  const admittedInput = admitConversationTurn(
    turnId,
    request,
    planned,
    journal,
    capabilities,
    notice,
    persistentNotice,
  );
  const modelInput = persistentNotice ? withNotice(admittedInput, persistentNotice) : admittedInput;
  if (hasProfileInput || (planned?.retryNotice && generation.notice(undefined) === planned.retryNotice.text)) {
    // A resumed retry can deliver the pending startup notice itself. Never
    // consume a different pending transition on an unrelated retry.
    generation.notice(undefined, true);
  }
  const rawHistory = planned?.history ?? snapshotHistory;
  let modelHistory = rawHistory;
  if (planned?.retryNotice) {
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

/** Only a durably completed turn may reconcile its decorated model prefix. */
export function completedConversationTurn(facts: readonly Fact[], turnId: TurnId): boolean {
  const ended = [...facts].reverse().find((fact) => fact.type === 'turn_ended' && fact.turnId === turnId);
  return ended?.type === 'turn_ended' && ended.outcome === 'completed';
}
