import deepEqual from 'fast-deep-equal';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function startsWith(input, prefix) {
    if (prefix.length > input.length)
        return false;
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
    protocol;
    stored = new Map();
    pending = new Map();
    nextSequence = 0;
    constructor(protocol) {
        this.protocol = protocol;
    }
    /**
     * Prepare a request for the wire.
     *
     * Stores the request as pending so a future `recordResponse` call can
     * correlate it. If a stored response chain exists for the same key and the
     * fingerprints match, the request input is trimmed to a delta. A matching
     * `previous_response_id` is used when the caller supplies one; otherwise the
     * stored id is adopted so callers that do not track response IDs still chain.
     */
    prepare(key, token, requestData) {
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
        const requestedPreviousResponseId = this.protocol.getPreviousResponseId(requestData);
        const stored = this.stored.get(key);
        // No stored chain, or the caller named a stale response id → full request.
        // Omitting previous_response_id is not a break: nested Luna explorers never
        // track the id, so the stored chain is the continuation the server holds.
        if (!stored || (requestedPreviousResponseId && stored.responseId !== requestedPreviousResponseId)) {
            return { requestData, usedDelta: false, token };
        }
        const previousResponseId = requestedPreviousResponseId ?? stored.responseId;
        // Fingerprint changed → incompatible chain, full request.
        if (stored.fingerprint !== fingerprint) {
            return { requestData, usedDelta: false, token };
        }
        // Try exact baseline match first.
        const baseline = [...stored.input, ...stored.outputItems];
        const prefix = this.protocol.getPrefix(input);
        const delta = startsWith(input, baseline)
            ? input.slice(baseline.length)
            : this.protocol.getContinuationDelta?.(input) ?? (startsWith(input, prefix) ? input.slice(prefix.length) : null);
        if (delta === null) {
            return { requestData, usedDelta: false, token };
        }
        return {
            requestData: { ...requestData, previous_response_id: previousResponseId, input: delta },
            usedDelta: true,
            token,
        };
    }
    /**
     * Record a completed response so it can be used for delta computation in
     * future requests on the same key.
     */
    recordResponse(key, token, responseId, outputItems) {
        const keyPending = this.pending.get(key);
        if (!keyPending)
            return;
        const pending = keyPending.get(token);
        if (!pending)
            return;
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
    abandon(key, token) {
        const keyPending = this.pending.get(key);
        if (!keyPending)
            return;
        keyPending.delete(token);
        if (keyPending.size === 0) {
            this.pending.delete(key);
        }
    }
    /**
     * Remove all state (stored and pending) for a single key.
     */
    invalidate(key) {
        this.stored.delete(key);
        this.pending.delete(key);
    }
    /**
     * Return the active stored response ID for a key, if any.
     */
    getStoredResponseId(key) {
        return this.stored.get(key)?.responseId;
    }
    /**
     * Remove all state across every key. Safe to call on an empty instance.
     */
    clear() {
        this.stored.clear();
        this.pending.clear();
    }
}
//# sourceMappingURL=chained-wire-state.js.map