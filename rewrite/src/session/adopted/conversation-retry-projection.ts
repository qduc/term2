/** Retry target selection stays owned by the source conversation store. */
import type { ProviderInputItem } from '../../../../source/contracts/provider-input.js';
import { ConversationStore } from '../../../../source/services/conversation/conversation-store.js';

export function projectRetryEligibility(history: readonly unknown[]): {
  readonly turn: boolean;
  readonly tool: boolean;
} {
  const source = new ConversationStore();
  for (const item of history) source.addImportedItem(item as ProviderInputItem);
  return {
    turn: source.listUserTurns().length > 0,
    tool: source.peekLastToolOutput() !== null,
  };
}
