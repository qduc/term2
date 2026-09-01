/**
 * A WebSocket message iterator only settles its pending `next()` promise when
 * the socket itself emits an event. A cancellation `AbortSignal` does not
 * touch the socket, so cancelling mid-turn left the iterator (and everything
 * awaiting it, up through `cancel_run`) suspended forever. This races the
 * iterator's pending promise against the signal so cancellation always
 * settles the wait, without closing or otherwise touching the underlying
 * socket — that remains the caller's responsibility.
 */
export function raceWebSocketAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(webSocketAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(webSocketAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Same `AbortError` shape the run loop and retry layer already check for (`error.name === 'AbortError'`). */
export function webSocketAbortError(reason?: unknown): Error {
  // Never mutate a shared reason object (e.g. a signal's DOMException, which
  // other listeners may also read); always hand back a fresh, owned error.
  const message = reason instanceof Error ? reason.message : 'The operation was aborted.';
  return Object.assign(new Error(message), { name: 'AbortError', cause: reason });
}
