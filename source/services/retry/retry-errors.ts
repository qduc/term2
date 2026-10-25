export class AmbiguousModelOutcomeError extends Error {
  readonly unsafeToReplay = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AmbiguousModelOutcomeError';
  }
}

/** Raw receive evidence captured by the WebSocket watchdog at expiry. */
export class WebSocketReceiveTimeoutError extends Error {
  readonly code = 'websocket_receive_timeout';

  constructor(
    readonly phase: 'first_frame' | 'inter_frame',
    readonly frameCount: number,
    readonly waitedMs: number,
    readonly budgetMs: number,
  ) {
    super(phase === 'first_frame' ? 'WebSocket first frame timeout' : 'WebSocket idle timeout');
    this.name = 'WebSocketReceiveTimeoutError';
  }
}

/**
 * The user-authorized ambiguous replay exception requires the watchdog's own
 * zero-frame evidence, not timeout wording or an arbitrary nested cause. This
 * does not assert that the request was unsent or that the provider did no work.
 */
export function getZeroFrameAmbiguousTimeout(error: unknown): WebSocketReceiveTimeoutError | undefined {
  if (!(error instanceof AmbiguousModelOutcomeError)) return undefined;
  const timeout = error.cause;
  return timeout instanceof WebSocketReceiveTimeoutError && timeout.phase === 'first_frame' && timeout.frameCount === 0
    ? timeout
    : undefined;
}

export class ConversationStateNoProgressError extends Error {
  readonly unrecoverable = true;

  constructor(message = 'Local conversation history is structurally incomplete and retry would not make progress.') {
    super(message);
    this.name = 'ConversationStateNoProgressError';
  }
}
