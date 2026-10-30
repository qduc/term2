import { ConversationStore } from '../../../../source/services/conversation/conversation-store.js';
export function projectRetryEligibility(history) {
    const source = new ConversationStore();
    for (const item of history)
        source.addImportedItem(item);
    return {
        turn: source.listUserTurns().length > 0,
        tool: source.peekLastToolOutput() !== null,
    };
}
//# sourceMappingURL=conversation-retry-projection.js.map