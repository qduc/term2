import deepEqual from 'fast-deep-equal';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChainedWireStateKey = string;
export type ChainedRequestToken = string;

/**
 * Protocol that a provider implements to plug into the chained-wire state
 * machine. Each method encapsulates a provider-specific concern so the
 * state machine itself stays transport- and model-agnostic.
 */
export interface ChainedWireProtocol {
  /** Extract the logical input array from a prepared request object. */
  getInput(requestData: Record<string, unknown>): unknown[];

  /** Extract the `previous_response_id` carried by the request, if any. */
  getPreviousResponseId(requestData: Record<string, unknown>): string | undefined;

  /**
   * Compute a stable fingerprint for a request. Two requests whose fingerprint
   * differs are treated as belonging to incompatible chains and will never
   * produce a delta from the same stored state.
   */
  getFingerprint(requestData: Record<string, unknown>, input: unknown[]): string;

  /**
   * Extract the reusable prefix from the input. When the full baseline does
   * not match (e.g. because the provider already holds earlier history), the
   * prefix acts as a fallback anchor: everything after the prefix becomes the
   * delta.
   */
  getPrefix(input: unknown[]): unknown[];

  /**
   * Normalize output items before they are stored for later replay matching.
   * This typically strips server-assigned ids so that the replayed items in a
   * subsequent request match the stored canonical form.
   */
  normalizeOutputItems(items: unknown[]): unknown[];
}

/** Result of preparing a request for the wire. */
export interface PreparedChainedRequest {
  /**
   * The request data that should be sent. When `usedDelta` is true, the
   * `input` field has been trimmed to only the items the server does not
   * already hold.
   */
  requestData: Record<string, unknown>;
  /** Whether a delta was computed from stored state. */
  usedDelta: boolean;
  /** Correlation token that pairs this preparation with a future `recordResponse` call. */
  token: ChainedRequestToken;
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface PendingRequest {
  fingerprint: string;
  input: unknown[];
  sequence: number;
}

interface StoredRequest extends PendingRequest {
  responseId: string;
  outputItems: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startsWith(input: unknown[], prefix: unknown[]): boolean {
  if (prefix.length > input.length) return false;
  return prefix.every((item, index) => deepEqual(item, input[index]));
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

/**
 * Provider-neutral state machine for chained-wire (delta) requests.
 *
 * Keeps the canonical request separate from the smaller payload sent over a
 * reused response chain. The caller may provide either the full logical input
 * or a server-managed delta. Strict baseline matching is preferred; prefix
 * matching is the safe fallback for requests whose older history is already
 * held by the provider.
 *
 * Requests are correlated by an opaque token so that multiple concurrent
 * requests under the same key can be tracked independently even when their
 * responses arrive out of order.
 */
export class ChainedWireState {
  private readonly stored = new Map<ChainedWireStateKey, StoredRequest>();
  private readonly pending = new Map<ChainedWireStateKey, Map<ChainedRequestToken, PendingRequest>>();
  private nextSequence = 0;

  constructor(private readonly protocol: ChainedWireProtocol) {}

  /**
   * Prepare a request for the wire.
   *
   * Stores the request as pending so a future `recordResponse` call can
   * correlate it. If a stored response chain exists for the same key and the
   * fingerprints and `previous_response_id` match, the request input is
   * trimmed to a delta.
   */
  prepare(
    key: ChainedWireStateKey,
    token: ChainedRequestToken,
    requestData: Record<string, unknown>,
  ): PreparedChainedRequest {
    const input = this.protocol.getInput(requestData);
    const fingerprint = this.protocol.getFingerprint(requestData, input);

    // Book the pending slot so recordResponse can correlate later.
    let keyPending = this.pending.get(key);
    if (!keyPending) {
      keyPending = new Map();
      this.pending.set(key, keyPending);
    }
    const existingPending = keyPending.get(token);
    keyPending.set(token, {
      fingerprint,
      input: [...input],
      sequence: existingPending?.sequence ?? this.nextSequence++,
    });

    const previousResponseId = this.protocol.getPreviousResponseId(requestData);
    const stored = this.stored.get(key);

    // No stored chain, missing previous_response_id, or stale response id →
    // full request.
    if (!stored || !previousResponseId || stored.responseId !== previousResponseId) {
      return { requestData, usedDelta: false, token };
    }

    // Fingerprint changed → incompatible chain, full request.
    if (stored.fingerprint !== fingerprint) {
      return { requestData, usedDelta: false, token };
    }

    // Try exact baseline match first.
    const baseline = [...stored.input, ...stored.outputItems];
    const prefix = this.protocol.getPrefix(input);
    const delta = startsWith(input, baseline)
      ? input.slice(baseline.length)
      : startsWith(input, prefix)
      ? input.slice(prefix.length)
      : null;

    if (delta === null) {
      return { requestData, usedDelta: false, token };
    }

    return {
      requestData: { ...requestData, input: delta },
      usedDelta: true,
      token,
    };
  }

  /**
   * Record a completed response so it can be used for delta computation in
   * future requests on the same key.
   */
  recordResponse(
    key: ChainedWireStateKey,
    token: ChainedRequestToken,
    responseId: string,
    outputItems: unknown[],
  ): void {
    const keyPending = this.pending.get(key);
    if (!keyPending) return;

    const pending = keyPending.get(token);
    if (!pending) return;

    const stored = this.stored.get(key);
    if (!stored || pending.sequence > stored.sequence) {
      this.stored.set(key, {
        ...pending,
        responseId,
        outputItems: Array.isArray(outputItems) ? this.protocol.normalizeOutputItems(outputItems) : [],
      });
    }
    keyPending.delete(token);
    if (keyPending.size === 0) {
      this.pending.delete(key);
    }
  }

  /**
   * Stop tracking a request that ended without an acknowledged response.
   */
  abandon(key: ChainedWireStateKey, token: ChainedRequestToken): void {
    const keyPending = this.pending.get(key);
    if (!keyPending) return;

    keyPending.delete(token);
    if (keyPending.size === 0) {
      this.pending.delete(key);
    }
  }

  /**
   * Remove all state (stored and pending) for a single key.
   */
  invalidate(key: ChainedWireStateKey): void {
    this.stored.delete(key);
    this.pending.delete(key);
  }

  /**
   * Remove all state across every key. Safe to call on an empty instance.
   */
  clear(): void {
    this.stored.clear();
    this.pending.clear();
  }
}
