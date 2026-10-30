export function resolveSlashCommand(commands, commandName) {
    const normalizedName = commandName.toLowerCase();
    const exactMatch = commands.find((command) => command.name.toLowerCase() === normalizedName);
    if (exactMatch)
        return exactMatch;
    const prefixMatches = commands.filter((command) => command.name.toLowerCase().startsWith(normalizedName));
    return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}
//# sourceMappingURL=slash-commands.js.map