import { validateMarkedSettings, validateSettingsBaseline } from '../settings/session-runtime-settings.js';
/**
 * Expands the new session writer's single-line atomic container into the
 * ordinary logical envelopes consumed by replay, browsing and the index.
 * Legacy envelopes are returned unchanged. A malformed recognized batch is
 * an integrity error; silently skipping its members could hide half a state
 * transition while leaving the physical record apparently valid.
 */
export function expandSessionFactBatchEnvelope(value) {
    const outer = decodeLogEnvelope(value);
    if (!outer || outer.event.type !== 'session_fact_batch')
        return null;
    const event = outer.event;
    const invalid = (reason) => {
        throw new Error(`invalid session_fact_batch: ${reason}`);
    };
    if (event['version'] !== 1)
        invalid('unsupported version');
    const rawEntries = event['entries'];
    if (!Array.isArray(rawEntries))
        invalid('entries must be an array');
    const batchEntries = rawEntries;
    if (batchEntries.length === 0)
        invalid('entries must be non-empty');
    const entries = [];
    const eventIds = new Set();
    let previousSeq = -1;
    for (let index = 0; index < batchEntries.length; index += 1) {
        const raw = batchEntries[index];
        if (typeof raw !== 'object' || raw === null)
            invalid(`entry ${index + 1} is not an envelope`);
        const candidate = raw;
        if (!Number.isSafeInteger(candidate['v']) ||
            !Number.isSafeInteger(candidate['seq']) ||
            Number(candidate['seq']) < 0 ||
            typeof candidate['ts'] !== 'string' ||
            typeof candidate['logId'] !== 'string' ||
            candidate['logId'].length === 0 ||
            typeof candidate['eventId'] !== 'string' ||
            candidate['eventId'].length === 0)
            invalid(`entry ${index + 1} has invalid envelope fields`);
        const entry = decodeLogEnvelope(candidate);
        if (entry === null)
            throw new Error(`invalid session_fact_batch: entry ${index + 1} has an invalid event`);
        if (entry.event.type === 'session_fact_batch')
            invalid(`entry ${index + 1} is nested`);
        if (entry.seq <= previousSeq)
            invalid(`entry ${index + 1} is out of order`);
        if (eventIds.has(entry.eventId))
            invalid(`entry ${index + 1} repeats an eventId`);
        previousSeq = entry.seq;
        eventIds.add(entry.eventId);
        entries.push(entry);
    }
    const final = entries.at(-1);
    if (outer.seq !== final.seq ||
        outer.ts !== final.ts ||
        outer.logId !== final.logId ||
        outer.eventId !== final.eventId)
        invalid('outer envelope does not match final entry');
    return entries;
}
/** Materialize stable references without collapsing distinct legacy records. */
export function resolveEnvelopeIdentities(envelopes, fallbackLogId, options = {}) {
    const deduplicateExplicitEventIds = options.deduplicateExplicitEventIds ?? true;
    const reservedIds = new Set(envelopes.flatMap((envelope) => (envelope.eventId ? [envelope.eventId] : [])));
    const usedIds = new Set();
    const seenExplicitIds = new Set();
    const legacyOccurrences = new Map();
    const resolved = [];
    for (const envelope of envelopes) {
        const logId = envelope.logId ?? fallbackLogId;
        if (envelope.eventId) {
            if (deduplicateExplicitEventIds && seenExplicitIds.has(envelope.eventId))
                continue;
            seenExplicitIds.add(envelope.eventId);
            usedIds.add(envelope.eventId);
            resolved.push({ ...envelope, logId });
            continue;
        }
        const occurrenceKey = JSON.stringify([logId, envelope.seq]);
        let occurrence = (legacyOccurrences.get(occurrenceKey) ?? 0) + 1;
        let eventId = occurrence === 1 ? `legacy:${logId}:${envelope.seq}` : `legacy:${logId}:${envelope.seq}:${occurrence}`;
        while (reservedIds.has(eventId) || usedIds.has(eventId)) {
            occurrence += 1;
            eventId = `legacy:${logId}:${envelope.seq}:${occurrence}`;
        }
        legacyOccurrences.set(occurrenceKey, occurrence);
        usedIds.add(eventId);
        resolved.push({ ...envelope, logId, eventId });
    }
    return resolved;
}
const isObject = (value) => typeof value === 'object' && value !== null;
const hasString = (value, key) => typeof value[key] === 'string';
const hasNumber = (value, key) => typeof value[key] === 'number';
const isMessage = (value) => isObject(value) && hasString(value, 'id') && hasString(value, 'sender');
const isSubmittedTurn = (value) => {
    if (!isObject(value) || !hasString(value, 'text'))
        return false;
    if (value['images'] !== undefined &&
        (!Array.isArray(value['images']) ||
            !value['images'].every((image) => isObject(image) &&
                hasString(image, 'id') &&
                hasString(image, 'data') &&
                hasString(image, 'mimeType') &&
                typeof image['byteSize'] === 'number' &&
                Number.isFinite(image['byteSize']) &&
                typeof image['displayNumber'] === 'number' &&
                Number.isFinite(image['displayNumber']))))
        return false;
    return (value['skill'] === undefined ||
        (isObject(value['skill']) &&
            hasString(value['skill'], 'name') &&
            hasString(value['skill'], 'description') &&
            hasString(value['skill'], 'body')));
};
const isJsonValue = (value, seen = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value))
        return false;
    if (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
        return false;
    seen.add(value);
    const valid = Array.isArray(value)
        ? value.every((item) => isJsonValue(item, seen))
        : Object.values(value).every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
};
const isSnapshot = (value) => isObject(value) &&
    Array.isArray(value['history']) &&
    (typeof value['previousResponseId'] === 'string' || value['previousResponseId'] === null) &&
    Array.isArray(value['toolLedger']) &&
    value['toolLedger'].every((entry) => isObject(entry) && validOccurrence(entry));
const isOneOf = (value, allowed) => typeof value === 'string' && allowed.includes(value);
const isEventReferences = (value) => {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const seen = new Set();
    for (const ref of value) {
        if (!isObject(ref) || !hasString(ref, 'logId') || !ref['logId'] || !hasString(ref, 'eventId') || !ref['eventId']) {
            return false;
        }
        const key = JSON.stringify([ref['logId'], ref['eventId']]);
        if (seen.has(key))
            return false;
        seen.add(key);
    }
    return true;
};
const validOccurrence = (value) => value['occurrence'] === undefined || (Number.isSafeInteger(value['occurrence']) && Number(value['occurrence']) > 0);
const isAssistantItem = (value) => {
    if (!isObject(value) || !hasString(value, 'type'))
        return false;
    switch (value['type']) {
        case 'reasoning':
        case 'assistant_text':
            return hasString(value, 'text');
        case 'tool_call':
            return hasString(value, 'callId') && hasString(value, 'toolName') && validOccurrence(value);
        case 'tool_result':
            return (hasString(value, 'callId') &&
                validOccurrence(value) &&
                hasString(value, 'toolName') &&
                isOneOf(value['status'], ['completed', 'failed', 'aborted', 'unknown']));
        default:
            return true;
    }
};
const isAssistantTurn = (value) => isObject(value) && Array.isArray(value['items']) && value['items'].every(isAssistantItem);
/** Validate fields replay dereferences on known event types. Unknown event types stay opaque. */
const isStructurallyValidKnownEvent = (event) => {
    switch (event['type']) {
        case 'session_init':
            return hasString(event, 'id') && hasString(event, 'createdAt');
        case 'session_settings_initialized':
            validateSettingsBaseline(event);
            return true;
        case 'settings_changed':
            if (Object.hasOwn(event, 'sessionMutation')) {
                validateMarkedSettings(event);
            }
            return hasString(event, 'key');
        case 'goal_changed': {
            const goal = event['goal'];
            if (!isObject(goal))
                return false;
            const id = goal['id'];
            const outcome = goal['outcome'];
            const criteria = goal['successCriteria'];
            return (event['version'] === 1 &&
                typeof id === 'string' &&
                id.length > 0 &&
                typeof outcome === 'string' &&
                outcome.length > 0 &&
                outcome.length <= 2000 &&
                (criteria === undefined || (typeof criteria === 'string' && criteria.length > 0 && criteria.length <= 2000)) &&
                isOneOf(goal['status'], ['active', 'achieved', 'abandoned']));
        }
        case 'events_retracted':
            return event['version'] === 1 && isEventReferences(event['refs']);
        case 'context_checkpoint_created': {
            const artifactId = event['artifactId'];
            return (event['version'] === 1 &&
                typeof artifactId === 'string' &&
                artifactId.length > 0 &&
                isEventReferences(event['sourceRefs']) &&
                (event['sourceDigest'] === undefined ||
                    (typeof event['sourceDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(event['sourceDigest']))) &&
                isObject(event['item']));
        }
        case 'user_message':
            return (isMessage(event['message']) &&
                isObject(event['message']) &&
                (event['message']['submittedTurn'] === undefined || isSubmittedTurn(event['message']['submittedTurn'])));
        case 'user_input_accepted':
        case 'user_turn_retried':
        case 'tool_output_rewound':
            return (event['version'] === 1 &&
                (event.type !== 'user_input_accepted' || (hasString(event, 'turnId') && !!event['turnId'])) &&
                (event.type === 'tool_output_rewound' || isEventReferences([event['userMessageRef']])) &&
                isSnapshot(event['snapshot']) &&
                isObject(event['snapshot']) &&
                Array.isArray(event['snapshot']['history']) &&
                event['snapshot']['history'].every((item) => isObject(item) && !Array.isArray(item)) &&
                (event['snapshot']['model'] === undefined || typeof event['snapshot']['model'] === 'string') &&
                (event['snapshot']['provider'] === undefined || typeof event['snapshot']['provider'] === 'string') &&
                isJsonValue(event['snapshot']));
        case 'command_message':
            return isMessage(event['message']);
        case 'assistant_journal_delta':
            return (hasString(event, 'turnId') &&
                hasNumber(event, 'seq') &&
                isOneOf(event['kind'], ['text', 'reasoning']) &&
                hasString(event, 'delta'));
        case 'assistant_journal_item':
            return hasString(event, 'turnId') && hasNumber(event, 'seq') && isAssistantItem(event['item']);
        case 'tool_started':
            return hasString(event, 'toolCallId') && hasString(event, 'toolName');
        case 'memory_injected':
            return (Array.isArray(event['memories']) &&
                event['memories'].every((memory) => isObject(memory) &&
                    isOneOf(memory['scope'], ['global', 'project']) &&
                    hasString(memory, 'id') &&
                    hasString(memory, 'title')));
        case 'tool_result':
            return (hasString(event, 'callId') &&
                validOccurrence(event) &&
                hasString(event, 'toolName') &&
                isOneOf(event['status'], ['completed', 'failed', 'aborted', 'unknown']));
        case 'approval_required':
            return isObject(event['approval']) && hasString(event['approval'], 'toolName');
        case 'approval_resolved':
            return isOneOf(event['answer'], ['y', 'n']);
        case 'subagent_started':
            return hasString(event, 'agentId') && hasString(event, 'role') && hasString(event, 'task');
        case 'subagent_tool_started':
            return (hasString(event, 'agentId') &&
                hasString(event, 'role') &&
                hasString(event, 'toolCallId') &&
                hasString(event, 'toolName'));
        case 'subagent_completed':
            return isObject(event['result']) && hasString(event['result'], 'agentId');
        case 'subagent_interrupted':
            return hasString(event, 'agentId') && hasString(event, 'role') && hasString(event, 'finalText');
        case 'subagent_transferred':
            return hasString(event, 'agentId') && hasString(event, 'runId') && hasString(event, 'role');
        case 'subagent_question':
            return (hasString(event, 'messageId') &&
                hasString(event, 'runId') &&
                hasString(event, 'role') &&
                hasString(event, 'question'));
        case 'background_shell_started':
            return hasString(event, 'jobId') && hasString(event, 'command');
        case 'background_shell_completed':
            return (hasString(event, 'jobId') &&
                hasString(event, 'command') &&
                hasString(event, 'output') &&
                isOneOf(event['status'], ['completed', 'failed', 'timed_out', 'cancelled']));
        case 'background_shell_output':
            return (hasString(event, 'jobId') &&
                hasString(event, 'command') &&
                hasString(event, 'watchId') &&
                hasNumber(event, 'seq') &&
                hasString(event, 'matchedLines'));
        case 'error':
            return hasString(event, 'message');
        case 'assistant_turn':
            return (isAssistantTurn(event['turn']) &&
                (event['providerHistory'] === undefined ||
                    (Array.isArray(event['providerHistory']) && event['providerHistory'].every(isObject))) &&
                (event['snapshot'] === undefined || isSnapshot(event['snapshot'])) &&
                (event['state'] === undefined ||
                    (isObject(event['state']) &&
                        (typeof event['state']['previousResponseId'] === 'string' ||
                            event['state']['previousResponseId'] === null))));
        case 'undo':
            return hasNumber(event, 'removedUserTurns') && isSnapshot(event['snapshot']);
        case 'openai_root_selector_parity':
        case 'openai_root_checkpoint_lifecycle':
            return hasNumber(event, 'version');
        case 'session_cleared':
            return true;
        case 'session_rollover':
            return ((event['reason'] === undefined || isOneOf(event['reason'], ['context_pressure', 'task_boundary'])) &&
                (hasString(event, 'brief') ||
                    (isOneOf(event['phase'], ['requested', 'blocked', 'completed']) &&
                        hasString(event, 'rolloverId') &&
                        hasString(event, 'sourceSessionId') &&
                        hasNumber(event, 'briefSize'))));
        default:
            return true;
    }
};
/**
 * Decodes a raw JSON value as a PersistedLogEnvelope if it matches envelope shape.
 * Permissive about extra fields on envelope and event, but strict on envelope structural requirements.
 */
export function decodeLogEnvelope(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const obj = value;
    if (typeof obj['event'] !== 'object' || obj['event'] === null) {
        return null;
    }
    const eventObj = obj['event'];
    const strictSettings = eventObj['type'] === 'session_settings_initialized' ||
        (eventObj['type'] === 'settings_changed' && Object.hasOwn(eventObj, 'sessionMutation'));
    if (strictSettings &&
        (!Number.isSafeInteger(obj['v']) ||
            !Number.isSafeInteger(obj['seq']) ||
            Number(obj['seq']) < 0 ||
            typeof obj['ts'] !== 'string' ||
            typeof obj['logId'] !== 'string' ||
            !obj['logId'] ||
            typeof obj['eventId'] !== 'string' ||
            !obj['eventId']))
        throw new Error('invalid session settings envelope');
    if (eventObj['truncated'] === true &&
        (eventObj['type'] === 'session_settings_initialized' ||
            (eventObj['type'] === 'settings_changed' && Object.hasOwn(eventObj, 'sessionMutation'))))
        throw new Error('truncated session settings fact');
    if (typeof eventObj['type'] !== 'string' ||
        (eventObj['truncated'] !== true && !isStructurallyValidKnownEvent(eventObj))) {
        return null;
    }
    const v = typeof obj['v'] === 'number' ? obj['v'] : 1;
    const seq = typeof obj['seq'] === 'number' ? obj['seq'] : 0;
    const ts = typeof obj['ts'] === 'string' ? obj['ts'] : '';
    let event;
    if (eventObj['truncated'] === true) {
        const truncatedEvent = {
            type: eventObj['type'],
            truncated: true,
            originalSize: typeof eventObj['originalSize'] === 'number' ? eventObj['originalSize'] : 0,
        };
        event = truncatedEvent;
    }
    else {
        event = eventObj;
    }
    return {
        v,
        seq,
        ts,
        ...(typeof obj['logId'] === 'string' && obj['logId'].length > 0 ? { logId: obj['logId'] } : {}),
        ...(typeof obj['eventId'] === 'string' && obj['eventId'].length > 0 ? { eventId: obj['eventId'] } : {}),
        event,
    };
}
/**
 * Validates/decodes a raw object into a Message, ensuring lifecycle-critical fields exist.
 * Permissive with extra fields to preserve forward compatibility.
 */
export function decodeSavedMessage(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const obj = value;
    if (typeof obj['id'] !== 'string' || typeof obj['sender'] !== 'string') {
        return null;
    }
    return obj;
}
//# sourceMappingURL=conversation-decoder.js.map