const dispatchStates = new WeakMap();
export function recordWebSocketDispatch(request, state) {
    dispatchStates.set(request, state);
}
/** Unrecorded requests read as `unknown`, so a missing record never authorizes a replay. */
export function readWebSocketDispatch(request) {
    return dispatchStates.get(request) ?? 'unknown';
}
/**
 * A request that failed before its frame reached the wire.
 *
 * Distinct from `AmbiguousModelOutcomeError`: this one carries positive
 * evidence that no model work could have started, so recovery may rebuild from
 * durable history instead of terminating the turn.
 */
export class UnsentWebSocketRequestError extends Error {
    provablyUnsent = true;
    constructor(message, options) {
        super(message, options);
        this.name = 'UnsentWebSocketRequestError';
    }
}
//# sourceMappingURL=websocket-request-dispatch.js.map