export function createClearSlashCommand(clearConversation, addSystemMessage) {
    return {
        name: 'clear',
        description: 'Start a new conversation',
        action: () => {
            void Promise.resolve(clearConversation()).then(() => {
                addSystemMessage('Welcome to term²! Type a message to start chatting.');
            });
        },
    };
}
//# sourceMappingURL=clear-command.js.map