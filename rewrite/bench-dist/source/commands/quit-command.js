export function createQuitSlashCommand(exit) {
    return {
        name: 'quit',
        description: 'Exit the application',
        action: () => {
            exit();
        },
    };
}
//# sourceMappingURL=quit-command.js.map