export type WebSocketReceiveTimeouts = {
  firstFrameMs: number;
  interFrameMs: number;
};

export const DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS: Readonly<WebSocketReceiveTimeouts> = {
  firstFrameMs: 90_000,
  interFrameMs: 600_000,
};

export type WebSocketReceiveWatchdog = {
  signal: AbortSignal;
  timeoutError: () => Error | undefined;
  close: () => void;
  wrap: <T>(raw: AsyncIterable<T>) => AsyncIterable<T>;
};

export function createWebSocketReceiveWatchdog(
  externalSignal: AbortSignal | undefined,
  timeouts: WebSocketReceiveTimeouts = DEFAULT_WEBSOCKET_RECEIVE_TIMEOUTS,
): WebSocketReceiveWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstFramePending = true;
  let expiredError: Error | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const removeExternalAbortListener = () => externalSignal?.removeEventListener('abort', abortForExternalSignal);
  const close = () => {
    clearTimer();
    removeExternalAbortListener();
  };
  const expire = () => {
    expiredError = new Error(firstFramePending ? 'WebSocket first frame timeout' : 'WebSocket idle timeout');
    close();
    controller.abort(expiredError);
  };
  const resetTimer = () => {
    clearTimer();
    timer = setTimeout(expire, firstFramePending ? timeouts.firstFrameMs : timeouts.interFrameMs);
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
    close,
    wrap<T>(raw: AsyncIterable<T>): AsyncIterable<T> {
      async function* watched(): AsyncIterable<T> {
        const iterator = raw[Symbol.asyncIterator]();
        let streamFailed = false;
        try {
          while (true) {
            resetTimer();
            const result = await iterator.next();
            if (result.done) return;
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
