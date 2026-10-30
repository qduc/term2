const TERM2_HOOK_SCHEMA_VERSION = 1;
export const TERM2_HOOK_EVENT_NAMES = [
    'session.start',
    'session.end',
    'status.change',
    'turn.start',
    'turn.end',
    'turn.error',
    'tool.before',
    'tool.after',
    'tool.error',
    'approval.requested',
    'approval.resolved',
];
function isTerm2HookEventName(value) {
    return typeof value === 'string' && TERM2_HOOK_EVENT_NAMES.includes(value);
}
function isTerm2HookScope(value) {
    if (value === 'root')
        return true;
    if (typeof value !== 'object' || value === null)
        return false;
    const subagent = value.subagent;
    return (typeof subagent === 'object' &&
        subagent !== null &&
        typeof subagent.agentId === 'string' &&
        typeof subagent.role === 'string');
}
export function isTerm2HookEvent(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const event = value;
    const hasString = (key) => typeof value[key] === 'string';
    const hasFiniteNumber = (key) => {
        const candidate = value[key];
        return typeof candidate === 'number' && Number.isFinite(candidate);
    };
    const hasBoolean = (key) => typeof value[key] === 'boolean';
    const oneOf = (key, candidates) => {
        const candidate = value[key];
        return typeof candidate === 'string' && candidates.includes(candidate);
    };
    if (!(isTerm2HookEventName(event.type) &&
        event.schemaVersion === TERM2_HOOK_SCHEMA_VERSION &&
        hasString('eventId') &&
        hasString('sessionId') &&
        hasFiniteNumber('timestamp') &&
        isTerm2HookScope(event.scope)))
        return false;
    switch (event.type) {
        case 'session.start':
            return (hasString('cwd') &&
                oneOf('mode', ['interactive', 'non-interactive']) &&
                hasString('providerName') &&
                hasString('modelName'));
        case 'session.end':
            return oneOf('reason', ['normal', 'fatal_error']) && hasFiniteNumber('sessionDuration');
        case 'status.change':
            return (oneOf('previous', ['idle', 'working', 'waiting_for_user', 'waiting_for_approval']) &&
                oneOf('current', ['idle', 'working', 'waiting_for_user', 'waiting_for_approval']) &&
                hasString('reason'));
        case 'turn.start':
            return oneOf('origin', ['user', 'queued', 'approval_continuation']);
        case 'turn.end':
            return oneOf('terminalKind', ['response', 'approval_required', 'stale', 'failed']) && hasFiniteNumber('duration');
        case 'turn.error':
            return hasString('errorCategory') && hasString('safeMessage') && hasBoolean('recoverable');
        case 'tool.before':
            return (hasString('toolName') &&
                hasFiniteNumber('attempt') &&
                isTerm2HookScope(value.ownership));
        case 'tool.after':
            return hasString('toolName') && hasFiniteNumber('duration');
        case 'tool.error':
            return (hasString('toolName') &&
                hasFiniteNumber('duration') &&
                hasString('errorCategory') &&
                hasString('safeMessage') &&
                hasBoolean('convertedToModelResult'));
        case 'approval.requested':
            return (hasString('toolName') &&
                oneOf('approvalKind', ['tool', 'ask_user', 'preflight', 'other']) &&
                oneOf('proposedDecision', ['approve', 'reject', 'abort', 'auto_approve']));
        case 'approval.resolved':
            return (oneOf('resolution', ['approved', 'rejected', 'aborted', 'auto_approved']) &&
                oneOf('source', ['user', 'policy', 'system']) &&
                hasBoolean('executionFollowed'));
    }
    return false;
}
//# sourceMappingURL=hook-contracts.js.map