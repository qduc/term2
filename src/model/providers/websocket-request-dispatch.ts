/**
 * Whether a WebSocket request frame reached the wire, tracked as evidence
 * rather than inferred from an error message.
 *
 * A receive-watchdog timeout is only safe to retry if the request provably
 * never went out. Sniffing error text for phrases like "before opening" cannot
 * establish that: the phrasing is the transport's, not a contract, and a wrong
 * guess replays a request the server may already have accepted. So the send
 * path records what it observed, and only a positive `unsent` record — never
 * the absence of one — permits a replay.
 */
export type WebSocketDispatchState =
  /** The frame was never handed to an open socket. Provably unsent. */
  | 'unsent'
  /** The frame was written to an open socket. The server may have accepted it. */
  | 'flushed'
  /** The send path could not observe the socket. Must be treated as ambiguous. */
  | 'unknown';

const dispatchStates = new WeakMap<object, WebSocketDispatchState>();

export function recordWebSocketDispatch(request: object, state: WebSocketDispatchState): void {
  dispatchStates.set(request, state);
}

/** Unrecorded requests read as `unknown`, so a missing record never authorizes a replay. */
export function readWebSocketDispatch(request: object): WebSocketDispatchState {
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
  readonly provablyUnsent = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnsentWebSocketRequestError';
  }
}
