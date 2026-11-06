import { AsyncLocalStorage } from 'node:async_hooks';

// Runtime-only physical request scope. No callback is serialized into provider
// options or durable events, and old callers without an observer are unchanged.
const dispatch = new AsyncLocalStorage<() => void>();

/** Called after handing an HTTP request or WebSocket message to its transport. */
export function notifyProviderRequestDispatched(): void {
  dispatch.getStore()?.();
}

/** Async generators are lazy: scope each pull, not just creation of the iterator. */
export async function* observeProviderRequestDispatch<T>(
  events: AsyncIterable<T>,
  onDispatched?: () => void,
): AsyncGenerator<T> {
  if (!onDispatched) {
    yield* events;
    return;
  }
  let notified = false;
  const notify = () => {
    if (notified) return;
    notified = true;
    onDispatched();
  };
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await dispatch.run(notify, () => iterator.next());
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await dispatch.run(notify, () => iterator.return?.());
  }
}
