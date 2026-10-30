export function parseInput(value) {
    if (!value.startsWith('/')) {
        return { type: 'message', text: value };
    }
    const commandLine = value.slice(1); // Remove leading '/'
    const [commandName, ...argsParts] = commandLine.split(/\s+/);
    const args = argsParts.join(' ');
    return { type: 'slash-command', commandName, args };
}
//# sourceMappingURL=input-parser.js.map