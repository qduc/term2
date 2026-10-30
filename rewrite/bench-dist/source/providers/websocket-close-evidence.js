import { UnsentWebSocketRequestError } from './websocket-request-dispatch.js';
/**
 * A Responses WebSocket that closed before any terminal response event.
 *
 * The close frame's code and reason are the only evidence that separates a
 * flaky network drop (retry) from a deliberate server rejection (do not), so
 * they are carried on the error and repeated in its message: the retry
 * classifier reads the code out of the message text, and both the app log and
 * the provider traffic log record only the message.
 */
export class WebSocketClosedEarlyError extends Error {
    closeCode;
    closeReason;
    unsentCount;
    constructor(evidence) {
        super(describeWebSocketClose(evidence));
        this.name = 'WebSocketClosedEarlyError';
        if (evidence.code !== undefined)
            this.closeCode = evidence.code;
        if (evidence.reason !== undefined)
            this.closeReason = evidence.reason;
        this.unsentCount = evidence.unsentCount ?? 0;
    }
}
/**
 * Keeps the `closed before a terminal response event` phrase that
 * `isIncompleteStreamTerminalError` matches on, and adds `code=NNNN` in the
 * shape `extractWebSocketCloseCode` parses.
 */
const describeWebSocketClose = (evidence) => {
    const details = [
        `code=${evidence.code ?? 'unknown'}`,
        `reason=${JSON.stringify(evidence.reason ?? '')}`,
        `unsent=${evidence.unsentCount ?? 0}`,
    ].join(' ');
    return `WebSocket connection closed before a terminal response event. (${details})`;
};
export const readWebSocketCloseFrame = (message) => {
    const frame = (message ?? {});
    return {
        type: 'close',
        ...(typeof frame.code === 'number' ? { code: frame.code } : {}),
        ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {}),
        ...(Array.isArray(frame.unsent) ? { unsent: frame.unsent } : {}),
    };
};
/**
 * Finds the close evidence anywhere in an error's cause chain. Recovery wraps
 * this error twice — once as provably-unsent, once as ambiguous — so the
 * instance is rarely the one that reaches a caller.
 */
export const findWebSocketClosedEarly = (error, seen = new Set()) => {
    if (!error || typeof error !== 'object' || seen.has(error))
        return undefined;
    seen.add(error);
    if (error instanceof WebSocketClosedEarlyError)
        return error;
    return findWebSocketClosedEarly(error.cause, seen);
};
/**
 * Turns a close frame into the error the recovery layers classify.
 *
 * A close while our request frame is still queued — either the frame is in the
 * close's `unsent` list, or the send path never saw an open socket — proves the
 * server never received the request, so the turn may be replayed as-is.
 * Anything else may already have been accepted and is only safe to rebuild from
 * full history.
 */
export const webSocketCloseError = (message, dispatchState) => {
    const frame = readWebSocketCloseFrame(message);
    const unsentCount = frame.unsent?.length ?? 0;
    const closed = new WebSocketClosedEarlyError({ ...frame, unsentCount });
    if (unsentCount > 0 || dispatchState === 'unsent') {
        return new UnsentWebSocketRequestError(closed.message, { cause: closed });
    }
    return closed;
};
//# sourceMappingURL=websocket-close-evidence.js.map