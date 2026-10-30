import { useCallback } from 'react';
/**
 * Sub-hook to delegate settings management to ConversationService.
 *
 * Provides callbacks for setModelSelection, setReasoningEffort, and setTemperature.
 */
export function useConversationSettings({ conversationService, }) {
    const setModelSelection = useCallback((selection) => {
        conversationService.setModelSelection(selection);
    }, [conversationService]);
    const setReasoningEffort = useCallback((effort) => {
        conversationService.setReasoningEffort(effort);
    }, [conversationService]);
    const setTemperature = useCallback((temperature) => {
        conversationService.setTemperature(temperature);
    }, [conversationService]);
    return {
        setModelSelection,
        setReasoningEffort,
        setTemperature,
    };
}
//# sourceMappingURL=use-conversation-settings.js.map