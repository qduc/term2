import { randomUUID } from 'node:crypto';
import { resolveSessionId } from '../session/session-identity.js';
/** Builds the versioned envelope without exposing provider/runtime IDs. */
export class HookEventFactory {
    #options;
    constructor(options) {
        this.#options = options;
    }
    create(type, payload, correlation = {}, scope = this.#options.scope ?? 'root') {
        return {
            type,
            schemaVersion: 1,
            eventId: randomUUID(),
            sessionId: resolveSessionId(this.#options.sessionId),
            timestamp: Date.now(),
            scope,
            ...correlation,
            ...payload,
        };
    }
    get includeUserText() {
        return this.#options.includeUserText === true;
    }
    get includeToolArguments() {
        return this.#options.includeToolArguments === true;
    }
    get includeToolResults() {
        return this.#options.includeToolResults === true;
    }
}
export function summarizeHookValue(value, maxLength = 500) {
    if (typeof value === 'string')
        return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean')
        return value;
    try {
        const text = JSON.stringify(value);
        if (text.length <= maxLength)
            return value;
        return `${text.slice(0, maxLength)}...`;
    }
    catch {
        return '[unserializable]';
    }
}
//# sourceMappingURL=hook-event-factory.js.map