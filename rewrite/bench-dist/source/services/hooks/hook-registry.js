const DEFAULT_HOOK_CALLBACK_TIMEOUT_MS = 5_000;
export class HookRegistrationClosedError extends Error {
    constructor() {
        super('Term2Hooks.on() may only be called while a hook registration function is running');
        this.name = 'HookRegistrationClosedError';
    }
}
function normalizeSource(source) {
    if (source === undefined)
        return undefined;
    return typeof source === 'string' ? { path: source } : source;
}
/**
 * Ordered, passive callback registry.  A registry deliberately has no
 * behavior-changing callback result: callbacks are observed and failures are
 * isolated from the application and from one another.
 */
export class HookRegistry {
    #callbacks = [];
    #seenEventIds = new Set();
    #timeoutMs;
    #logger;
    #activeFrame;
    constructor(options = {}) {
        const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_HOOK_CALLBACK_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new RangeError('Hook callback timeout must be a finite number greater than zero');
        }
        this.#timeoutMs = timeoutMs;
        this.#logger = options.logger;
    }
    get callbackTimeoutMs() {
        return this.#timeoutMs;
    }
    get size() {
        return this.#callbacks.filter((callback) => callback.active).length;
    }
    /**
     * Load one module's registration function transactionally.  If registration
     * throws, every callback added by that module is removed before the error is
     * rethrown to the service, so a broken file cannot leave a partial module.
     */
    async register(source, registration) {
        let registrationFunction;
        let registrationSource;
        if (typeof source === 'function') {
            registrationFunction = source;
            registrationSource = normalizeSource(registration);
        }
        else {
            if (typeof registration !== 'function') {
                throw new TypeError('A hook registration function is required');
            }
            registrationFunction = registration;
            registrationSource = normalizeSource(source);
        }
        if (this.#activeFrame) {
            throw new Error('Hook registrations cannot run concurrently');
        }
        const frame = { source: registrationSource, callbacks: [], active: true };
        this.#activeFrame = frame;
        try {
            await registrationFunction(this.#createRegistrar(frame));
        }
        catch (error) {
            for (const callback of frame.callbacks)
                callback.active = false;
            this.#log({
                code: 'registration_rejected',
                message: 'Hook registration failed; all callbacks from the module were rolled back',
                source: frame.source,
                error,
            });
            throw error;
        }
        finally {
            frame.active = false;
            if (this.#activeFrame === frame)
                this.#activeFrame = undefined;
        }
    }
    /** Alias that makes the transactional boundary explicit at call sites. */
    registerModule(source, registration) {
        return this.register(source, registration);
    }
    async dispatch(event) {
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
            if (!registered.active || registered.event !== event.type)
                continue;
            await this.#dispatchOne(registered, event, index);
        }
    }
    /** Remove all callbacks and make a future service run start cleanly. */
    clear() {
        for (const callback of this.#callbacks)
            callback.active = false;
        this.#callbacks.length = 0;
        this.#seenEventIds.clear();
    }
    #createRegistrar(frame) {
        return {
            on: (event, callback) => {
                if (!frame.active || this.#activeFrame !== frame)
                    throw new HookRegistrationClosedError();
                if (typeof callback !== 'function')
                    throw new TypeError('A hook callback must be a function');
                const registered = {
                    event,
                    callback: callback,
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
    async #dispatchOne(registered, event, callbackIndex) {
        const startedAt = Date.now();
        let timer;
        // Attach a rejection handler to the callback promise before racing it.  A
        // timed-out callback may continue running, and its eventual rejection must
        // not become an unhandled rejection.
        const callbackPromise = Promise.resolve()
            .then(() => registered.callback(event))
            .then(() => undefined, (error) => {
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
        });
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.#timeoutMs);
        });
        const result = await Promise.race([callbackPromise.then(() => 'callback'), timeoutPromise]);
        if (timer !== undefined)
            clearTimeout(timer);
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
    #log(diagnostic) {
        if (!this.#logger)
            return;
        try {
            this.#logger(diagnostic);
        }
        catch (error) {
            // Diagnostics must never turn a passive hook failure into an application
            // failure. There is nowhere safe to report a logger failure from here.
            void error;
        }
    }
}
//# sourceMappingURL=hook-registry.js.map