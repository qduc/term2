import type { ProviderTrafficReceiveTiming } from '../services/service-interfaces.js';

export type WebSocketReceiveTimeouts = {
  firstFrameMs: number;
  interFrameMs: number;
};

export const DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS: Readonly<WebSocketReceiveTimeouts> = {
  firstFrameMs: 90_000,
  interFrameMs: 600_000,
};

/**
 * What this watchdog observed, reported in the same clock it judges expiry
 * with. Without it, the only way to learn a budget is too tight is for a live
 * request to lose its turn to a false positive.
 */
export type WebSocketReceiveTiming = ProviderTrafficReceiveTiming;

export type WebSocketReceiveWatchdog = {
  signal: AbortSignal;
  timeoutError: () => Error | undefined;
  receiveTiming: () => WebSocketReceiveTiming;
  close: () => void;
  wrap: <T>(raw: AsyncIterable<T>) => AsyncIterable<T>;
};

export function createWebSocketReceiveWatchdog(
  externalSignal: AbortSignal | undefined,
  timeouts: WebSocketReceiveTimeouts = DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
  now: () => number = Date.now,
): WebSocketReceiveWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstFramePending = true;
  let expiredError: Error | undefined;
  let pendingReject: ((error: Error) => void) | undefined;
  let waitStartedAtMs: number | undefined;
  let frameCount = 0;
  let firstFrameMs: number | undefined;
  let maxInterFrameMs: number | undefined;
  let waitedMs: number | undefined;

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
    expiredError = new Error(firstFramePending ? 'WebSocket first frame timeout' : 'WebSocket idle timeout');
    waitedMs = waitStartedAtMs === undefined ? undefined : now() - waitStartedAtMs;
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
    if (firstFramePending) firstFrameMs = elapsed;
    else maxInterFrameMs = Math.max(maxInterFrameMs ?? 0, elapsed);
  };
  const abortForExternalSignal = () => {
    close();
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortForExternalSignal();
  } else {
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
    wrap<T>(raw: AsyncIterable<T>): AsyncIterable<T> {
      async function* watched(): AsyncIterable<T> {
        const iterator = raw[Symbol.asyncIterator]();
        let streamFailed = false;
        try {
          while (true) {
            resetTimer();
            const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
              pendingReject = reject;
              void iterator.next().then(resolve, reject);
            });
            pendingReject = undefined;
            if (result.done) return;
            observeFrame();
            firstFramePending = false;
            resetTimer();
            yield result.value;
          }
        } catch (error) {
          streamFailed = true;
          throw expiredError ?? error;
        } finally {
          close();
          if (streamFailed) {
            try {
              void Promise.resolve(iterator.return?.()).catch(() => {});
            } catch {
              // Preserve the stream failure when synchronous cleanup also fails.
            }
          } else {
            await iterator.return?.();
          }
        }
      }

      return watched();
    },
  };
}
