export const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
export const getString = (record, key) => {
    const value = record?.[key];
    return typeof value === 'string' ? value : undefined;
};
export const getMethod = (target, key) => {
    const record = asRecord(target);
    const candidate = record?.[key];
    return typeof candidate === 'function' ? candidate.bind(record) : null;
};
export const getCallIdFromObject = (value) => {
    const record = asRecord(value);
    const rawItem = asRecord(record?.rawItem);
    const topLevelCallId = getString(record, 'callId') ??
        getString(record, 'call_id') ??
        getString(record, 'tool_call_id') ??
        getString(record, 'toolCallId');
    if (topLevelCallId) {
        return topLevelCallId;
    }
    const nestedCallId = getString(rawItem, 'callId') ??
        getString(rawItem, 'call_id') ??
        getString(rawItem, 'tool_call_id') ??
        getString(rawItem, 'toolCallId');
    if (nestedCallId) {
        return nestedCallId;
    }
    return getString(rawItem, 'id') ?? getString(record, 'id');
};
export const getCommandFromArgs = (args) => {
    if (!args) {
        return '';
    }
    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            if (parsed?.command) {
                return parsed.command;
            }
            if (Array.isArray(parsed?.commands)) {
                return parsed.commands.join('\n');
            }
            return JSON.stringify(parsed);
        }
        catch {
            return args;
        }
    }
    if (typeof args === 'object') {
        const argsRecord = asRecord(args);
        const cmdFromObject = argsRecord?.command !== undefined ? String(argsRecord.command) : undefined;
        if (Array.isArray(argsRecord?.commands)) {
            return argsRecord.commands.join('\n');
        }
        let argsFromObject;
        if (argsRecord?.arguments !== undefined) {
            const rawArguments = argsRecord.arguments;
            if (typeof rawArguments === 'string') {
                try {
                    argsFromObject = JSON.stringify(JSON.parse(rawArguments));
                }
                catch {
                    argsFromObject = String(rawArguments);
                }
            }
            else if (rawArguments !== undefined) {
                argsFromObject = String(rawArguments);
            }
        }
        return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
    }
    return String(args);
};
export const getToolInfoFromInterruption = (interruption) => {
    const interruptionRecord = asRecord(interruption);
    const toolName = getString(interruptionRecord, 'name') ?? 'unknown';
    const rawArguments = interruptionRecord?.arguments;
    let argumentsText = '';
    if (getString(interruptionRecord, 'type') === 'shell_call') {
        const action = asRecord(interruptionRecord?.action);
        const actionCommands = action?.commands;
        if (actionCommands) {
            argumentsText = Array.isArray(actionCommands) ? actionCommands.join('\n') : String(actionCommands);
        }
    }
    else {
        argumentsText = getCommandFromArgs(rawArguments);
    }
    return { toolName, argumentsText, rawArguments };
};
//# sourceMappingURL=interruption-info.js.map