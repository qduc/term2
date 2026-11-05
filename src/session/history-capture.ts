/** Native command boundaries come from original admissions, never visible-message guesses. */
import type { Item, ItemId } from '../model/index.js';
import type { Fact } from './facts.js';
import type { DirectCommandSnapshot } from './command-types.js';
import { createDirectQueueState, directQueueSteeredInput } from './queue.js';
import { foldFact } from './fold-fact.js';

/** Capture retained raw admissions/context and root execution identity after physical drain. */
export function captureDirectCommandHistory(input: {
  readonly sessionId: string;
  readonly revision: string;
  readonly facts: readonly Fact[];
  readonly history: readonly Item[];
  readonly executionsSettled: boolean;
}): DirectCommandSnapshot {
  const admissions = new Map<ItemId, { messageId: ItemId; retryThroughId: ItemId }>();
  const toolResults: DirectCommandSnapshot['toolResults'][number][] = [];
  let queue = createDirectQueueState();
  const admit = (items: readonly Item[]): void => {
    for (const [index, item] of items.entries()) {
      if (item.type !== 'user_message') continue;
      let through = item.id;
      for (const next of items.slice(index + 1)) {
        if (next.type === 'user_message') break;
        if (next.type !== 'summary' && next.type !== 'provider_input') break;
        through = next.id;
      }
      admissions.set(item.id, { messageId: item.id, retryThroughId: through });
    }
  };
  for (const fact of input.facts) {
    if (fact.type === 'turn_started' && !fact.retryContext && !fact.silent) admit(fact.input);
    if (fact.type === 'queue_steered') admit(directQueueSteeredInput(queue, fact));
    queue = foldFact({ queue }, fact).queue;
    if (fact.type === 'item' && fact.item.type === 'tool_result' && fact.executionId)
      toolResults.push({ executionId: fact.executionId, itemId: fact.item.id });
  }
  const retained = new Set(input.history.map((item) => item.id));
  return {
    sessionId: input.sessionId,
    revision: input.revision,
    history: input.history,
    executionsSettled: input.executionsSettled,
    // A compacted-away context anchor cannot become a guessed retry boundary.
    admissions: [...admissions.values()].filter(
      (admission) => retained.has(admission.messageId) && retained.has(admission.retryThroughId),
    ),
    toolResults,
  };
}
