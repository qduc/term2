import { getLastFinalAssistantText } from '../utils/conversation/message-utils.js';
export function createHandoffSlashCommand({ messages, addSystemMessage, onHandoff, }) {
    return {
        name: 'handoff',
        description: 'Send the last assistant response to another model for review',
        action: () => {
            const lastText = getLastFinalAssistantText(messages);
            if (!lastText) {
                addSystemMessage('No assistant response available to hand off.');
                return true;
            }
            onHandoff?.(lastText);
            return true;
        },
    };
}
//# sourceMappingURL=handoff-command.js.map