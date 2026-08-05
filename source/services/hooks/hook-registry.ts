import type {
  Term2HookCallback,
  Term2HookEvent,
  Term2HookEventName,
  Term2HookRegistration,
  Term2Hooks,
} from './hook-contracts.js';

export const DEFAULT_HOOK_CALLBACK_TIMEOUT_MS = 5_000;

export interface HookRegistrationSource {
  readonly path?: string;
  readonly scope?: 'user' | 'project' | string;
}

export interface HookDiagnostic {
  readonly code:
    | 'registration_rejected'
    | 'callback_failed'
    | 'callback_timed_out'
    | 'diagnostic_logger_failed'
    | 'duplicate_event'
    | 'discovery_failed'
    | 'symlink_rejected'
    | 'project_hooks_untrusted'
    | 'hook_disabled'
    | 'module_load_failed';
  readonly message: string;
  readonly source?: HookRegistrationSource;
  readonly eventType?: Term2HookEventName;
  readonly callbackIndex?: number;
  readonly eventId?: string;
  readonly durationMs?: number;
  readonly error?: unknown;
}

export type HookDiagnosticLogger = (diagnostic: HookDiagnostic) => void;

export interface HookRegistryOptions {
  readonly callbackTimeoutMs?: number;
  readonly logger?: HookDiagnosticLogger;
}

export class HookRegistrationClosedError extends Error {
  constructor() {
    super('Term2Hooks.on() may only be called while a hook registration function is running');
    this.name = 'HookRegistrationClosedError';
  }
}

interface RegisteredCallback {
  readonly event: Term2HookEventName;
  readonly callback: Term2HookCallback<Term2HookEventName>;
  readonly source?: HookRegistrationSource;
  active: boolean;
}

interface RegistrationFrame {
  readonly source?: HookRegistrationSource;
  readonly callbacks: RegisteredCallback[];
  active: boolean;
}

function normalizeSource(source?: string | HookRegistrationSource): HookRegistrationSource | undefined {
  if (source === undefined) return undefined;
  return typeof source === 'string' ? { path: source } : source;
}

/**
 * Ordered, passive callback registry.  A registry deliberately has no
 * behavior-changing callback result: callbacks are observed and failures are
 * isolated from the application and from one another.
 */
export class HookRegistry {
  readonly #callbacks: RegisteredCallback[] = [];
  readonly #seenEventIds = new Set<string>();
  readonly #timeoutMs: number;
  readonly #logger?: HookDiagnosticLogger;
  #activeFrame: RegistrationFrame | undefined;

  constructor(options: HookRegistryOptions = {}) {
    const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_HOOK_CALLBACK_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Hook callback timeout must be a finite number greater than zero');
    }
    this.#timeoutMs = timeoutMs;
    this.#logger = options.logger;
  }

  get callbackTimeoutMs(): number {
    return this.#timeoutMs;
  }

  get size(): number {
    return this.#callbacks.filter((callback) => callback.active).length;
  }

  /**
   * Load one module's registration function transactionally.  If registration
   * throws, every callback added by that module is removed before the error is
   * rethrown to the service, so a broken file cannot leave a partial module.
   */
  async register(
    source: string | HookRegistrationSource | Term2HookRegistration,
    registration?: HookRegistrationSource | Term2HookRegistration,
  ): Promise<void> {
    let registrationFunction: Term2HookRegistration;
    let registrationSource: HookRegistrationSource | undefined;

    if (typeof source === 'function') {
      registrationFunction = source;
      registrationSource = normalizeSource(registration as HookRegistrationSource | undefined);
    } else {
      if (typeof registration !== 'function') {
        throw new TypeError('A hook registration function is required');
      }
      registrationFunction = registration;
      registrationSource = normalizeSource(source);
    }

    if (this.#activeFrame) {
      throw new Error('Hook registrations cannot run concurrently');
    }

    const frame: RegistrationFrame = { source: registrationSource, callbacks: [], active: true };
    this.#activeFrame = frame;
    try {
      await registrationFunction(this.#createRegistrar(frame));
    } catch (error) {
      for (const callback of frame.callbacks) callback.active = false;
      this.#log({
        code: 'registration_rejected',
        message: 'Hook registration failed; all callbacks from the module were rolled back',
        source: frame.source,
        error,
      });
      throw error;
    } finally {
      frame.active = false;
      if (this.#activeFrame === frame) this.#activeFrame = undefined;
    }
  }

  /** Alias that makes the transactional boundary explicit at call sites. */
  registerModule(source: string | HookRegistrationSource, registration: Term2HookRegistration): Promise<void> {
    return this.register(source, registration);
  }

  async dispatch<Name extends Term2HookEventName>(event: Term2HookEvent<Name>): Promise<void> {
    if (this.#seenEventIds.has(event.eventId)) {
      this.#log({
        code: 'duplicate_event',
        message: 'Skipped a hook event whose eventId had already been dispatched',
        eventType: event.type,
        eventId: event.eventId,
      });
      return;
    }
    this.#seenEventIds.add(event.eventId);

    // Keep the registration order, but consult active at invocation time so an
    // unsubscribe from an earlier callback takes effect immediately.
    for (let index = 0; index < this.#callbacks.length; index += 1) {
      const registered = this.#callbacks[index];
      if (!registered.active || registered.event !== event.type) continue;
      await this.#dispatchOne(registered, event, index);
    }
  }

  /** Remove all callbacks and make a future service run start cleanly. */
  clear(): void {
    for (const callback of this.#callbacks) callback.active = false;
    this.#callbacks.length = 0;
    this.#seenEventIds.clear();
  }

  #createRegistrar(frame: RegistrationFrame): Term2Hooks {
    return {
      on: <Name extends Term2HookEventName>(event: Name, callback: Term2HookCallback<Name>): (() => void) => {
        if (!frame.active || this.#activeFrame !== frame) throw new HookRegistrationClosedError();
        if (typeof callback !== 'function') throw new TypeError('A hook callback must be a function');

        const registered: RegisteredCallback = {
          event,
          callback: callback as Term2HookCallback<Term2HookEventName>,
          source: frame.source,
          active: true,
        };
        frame.callbacks.push(registered);
        this.#callbacks.push(registered);
        return () => {
          registered.active = false;
        };
      },
    };
  }

  async #dispatchOne<Name extends Term2HookEventName>(
    registered: RegisteredCallback,
    event: Term2HookEvent<Name>,
    callbackIndex: number,
  ): Promise<void> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Attach a rejection handler to the callback promise before racing it.  A
    // timed-out callback may continue running, and its eventual rejection must
    // not become an unhandled rejection.
    const callbackPromise = Promise.resolve()
      .then(() => registered.callback(event as Term2HookEvent<Term2HookEventName>))
      .then(
        () => undefined,
        (error: unknown) => {
          this.#log({
            code: 'callback_failed',
            message: 'Hook callback failed; continuing with the next callback',
            source: registered.source,
            eventType: event.type,
            callbackIndex,
            eventId: event.eventId,
            durationMs: Date.now() - startedAt,
            error,
          });
        },
      );
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#timeoutMs);
    });

    const result = await Promise.race([callbackPromise.then(() => 'callback' as const), timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === 'timeout') {
      this.#log({
        code: 'callback_timed_out',
        message: 'Hook callback timed out; the in-process callback cannot be cancelled and may continue running',
        source: registered.source,
        eventType: event.type,
        callbackIndex,
        eventId: event.eventId,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  #log(diagnostic: HookDiagnostic): void {
    if (!this.#logger) return;
    try {
      this.#logger(diagnostic);
    } catch (error) {
      // Diagnostics must never turn a passive hook failure into an application
      // failure. There is nowhere safe to report a logger failure from here.
      void error;
    }
  }
}
