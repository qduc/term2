const defaultScheduler = {
    now: Date.now,
    setTimeout,
    clearTimeout,
};
export const createThrottledFunction = (fn, intervalMs, scheduler = defaultScheduler) => {
    let lastCallTime = 0;
    let timeout = null;
    let pendingArgs = null;
    const invoke = () => {
        if (!pendingArgs)
            return;
        const args = pendingArgs;
        pendingArgs = null;
        lastCallTime = scheduler.now();
        fn(...args);
    };
    const schedule = (delayMs) => {
        if (timeout)
            return;
        timeout = scheduler.setTimeout(() => {
            timeout = null;
            invoke();
        }, delayMs);
    };
    const throttled = (...args) => {
        pendingArgs = args;
        if (timeout)
            return;
        const now = scheduler.now();
        const elapsed = now - lastCallTime;
        if (elapsed >= intervalMs) {
            invoke();
            return;
        }
        schedule(intervalMs - elapsed);
    };
    const flush = () => {
        if (timeout) {
            scheduler.clearTimeout(timeout);
            timeout = null;
        }
        invoke();
    };
    const cancel = () => {
        if (timeout) {
            scheduler.clearTimeout(timeout);
            timeout = null;
        }
        pendingArgs = null;
    };
    return { throttled, flush, cancel };
};
//# sourceMappingURL=throttle.js.map