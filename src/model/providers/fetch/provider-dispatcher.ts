/**
 * Node's bundled `fetch` (undici) applies its own 300 s headers/body inactivity
 * timeouts to every request. On a provider stream those defaults pre-empt
 * Term2's provider-neutral stream-idle watchdog: a silent SSE stall surfaced as
 * an opaque `TypeError: terminated` (`UND_ERR_BODY_TIMEOUT`) at 300 s instead
 * of the guard's typed, configurable `stream_inactivity` failure. The transport
 * must not decide how long a provider request may stay quiet.
 *
 * Node's `fetch` honours a per-request `dispatcher`, and undici reads
 * `bodyTimeout`/`headersTimeout` from the dispatch options before falling back
 * to the client defaults (`client-h1.js` on response headers, `client-h2.js` in
 * `writeH2`). Routing this lane through a thin wrapper that pins both to `0`
 * therefore disables the transport timeouts without touching other fetches
 * (model listing, OAuth, decisions) or the process-wide dispatcher.
 * `connectTimeout` stays at its default: a failed connect is a distinct phase
 * that already classifies as retryable.
 */

type DispatchOptions = {
  bodyTimeout?: number | null;
  headersTimeout?: number | null;
  [option: string]: unknown;
};

type Dispatcher = {
  dispatch(options: DispatchOptions, handler: unknown): unknown;
};

const GLOBAL_DISPATCHER_SYMBOL = Symbol.for('undici.globalDispatcher.1');

/**
 * undici stores the process's dispatcher on an internal symbol shared by Node's
 * bundled copy and the npm package. The module is loaded lazily, so the symbol
 * can be absent until some other undici API is used; `new Headers()` loads it
 * without doing network work. If a future Node stops exposing the symbol, this
 * returns undefined and the lane keeps plain-fetch behaviour.
 */
function resolveGlobalDispatcher(): Dispatcher | undefined {
  const globalStore = globalThis as Record<symbol, unknown>;
  const existing = globalStore[GLOBAL_DISPATCHER_SYMBOL] as Dispatcher | undefined;
  if (existing) return existing;

  new Headers();
  return globalStore[GLOBAL_DISPATCHER_SYMBOL] as Dispatcher | undefined;
}

/** undefined = not resolved yet, null = this runtime does not expose it. */
let providerDispatcher: Dispatcher | null | undefined;

function timeoutFreeDispatcher(): Dispatcher | undefined {
  if (providerDispatcher === undefined) {
    const base = resolveGlobalDispatcher();
    providerDispatcher = base
      ? {
          dispatch: (options, handler) => base.dispatch({ ...options, bodyTimeout: 0, headersTimeout: 0 }, handler),
        }
      : null;
  }
  return providerDispatcher ?? undefined;
}

/**
 * Adds the timeout-free dispatcher to a provider request. Only the native
 * `fetch` understands `dispatcher`; an injected implementation keeps its own
 * semantics.
 */
export function disableTransportTimeouts(
  init: RequestInit | undefined,
  fetchImpl: typeof fetch,
): RequestInit | undefined {
  if (fetchImpl !== fetch) return init;
  const dispatcher = timeoutFreeDispatcher();
  if (!dispatcher) return init;
  // `RequestInit` in @types/node predates the runtime `dispatcher` option.
  return { ...init, dispatcher } as RequestInit;
}
