import { WebSocketReceiveTimeoutError } from '../services/retry/retry-errors.js';
export const DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS = {
    firstFrameMs: 90_000,
    interFrameMs: 600_000,
};
export function createWebSocketReceiveWatchdog(externalSignal, timeouts = DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS, now = Date.now) {
    const controller = new AbortController();
    let timer;
    let firstFramePending = true;
    let expiredError;
    let pendingReject;
    let waitStartedAtMs;
    let frameCount = 0;
    let firstFrameMs;
    let maxInterFrameMs;
    let waitedMs;
    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    const removeExternalAbortListener = () => externalSignal?.removeEventListener('abort', abortForExternalSignal);
    const close = () => {
        clearTimer();
        pendingReject = undefined;
        removeExternalAbortListener();
    };
    const expire = () => {
        waitedMs = waitStartedAtMs === undefined ? 0 : Math.max(0, now() - waitStartedAtMs);
        expiredError = new WebSocketReceiveTimeoutError(firstFramePending ? 'first_frame' : 'inter_frame', frameCount, waitedMs, firstFramePending ? timeouts.firstFrameMs : timeouts.interFrameMs);
        const rejectPending = pendingReject;
        close();
        controller.abort(expiredError);
        rejectPending?.(expiredError);
    };
    const resetTimer = () => {
        clearTimer();
        // The measured wait starts where the deadline does, so a reported latency is
        // always the same quantity the guard would have expired on.
        waitStartedAtMs = now();
        timer = setTimeout(expire, firstFramePending ? timeouts.firstFrameMs : timeouts.interFrameMs);
    };
    const observeFrame = () => {
        const elapsed = waitStartedAtMs === undefined ? 0 : now() - waitStartedAtMs;
        frameCount += 1;
        if (firstFramePending)
            firstFrameMs = elapsed;
        else
            maxInterFrameMs = Math.max(maxInterFrameMs ?? 0, elapsed);
    };
    const abortForExternalSignal = () => {
        close();
        controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted) {
        abortForExternalSignal();
    }
    else {
        externalSignal?.addEventListener('abort', abortForExternalSignal, { once: true });
    }
    return {
        signal: controller.signal,
        timeoutError: () => expiredError,
        receiveTiming: () => ({
            frameCount,
            firstFrameBudgetMs: timeouts.firstFrameMs,
            interFrameBudgetMs: timeouts.interFrameMs,
            ...(firstFrameMs === undefined ? {} : { firstFrameMs }),
            ...(maxInterFrameMs === undefined ? {} : { maxInterFrameMs }),
            ...(waitedMs === undefined ? {} : { waitedMs }),
        }),
        close,
        wrap(raw) {
            async function* watched() {
                const iterator = raw[Symbol.asyncIterator]();
                let streamFailed = false;
                try {
                    while (true) {
                        resetTimer();
                        const result = await new Promise((resolve, reject) => {
                            pendingReject = reject;
                            void iterator.next().then(resolve, reject);
                        });
                        pendingReject = undefined;
                        if (result.done)
                            return;
                        observeFrame();
                        firstFramePending = false;
                        resetTimer();
                        yield result.value;
                    }
                }
                catch (error) {
                    streamFailed = true;
                    throw expiredError ?? error;
                }
                finally {
                    close();
                    if (streamFailed) {
                        try {
                            void Promise.resolve(iterator.return?.()).catch(() => { });
                        }
                        catch {
                            // Preserve the stream failure when synchronous cleanup also fails.
                        }
                    }
                    else {
                        await iterator.return?.();
                    }
                }
            }
            return watched();
        },
    };
}
//# sourceMappingURL=websocket-receive-watchdog.js.map