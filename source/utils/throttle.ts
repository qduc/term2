export type ThrottledFunction<Args extends unknown[]> = {
    throttled: (...args: Args) => void;
    flush: () => void;
    cancel: () => void;
};

export const createThrottledFunction = <Args extends unknown[]>(
    fn: (...args: Args) => void,
    intervalMs: number,
): ThrottledFunction<Args> => {
    let lastCallTime = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let pendingArgs: Args | null = null;

    const invoke = () => {
        if (!pendingArgs) return;
        const args = pendingArgs;
        pendingArgs = null;
        lastCallTime = Date.now();
        fn(...args);
    };

    const schedule = (delayMs: number) => {
        if (timeout) return;
        timeout = setTimeout(() => {
            timeout = null;
            invoke();
        }, delayMs);
    };

    const throttled = (...args: Args) => {
        pendingArgs = args;
        if (timeout) return;
        const now = Date.now();
        const elapsed = now - lastCallTime;
        if (elapsed >= intervalMs) {
            invoke();
            return;
        }
        schedule(intervalMs - elapsed);
    };

    const flush = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        invoke();
    };

    const cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        pendingArgs = null;
    };

    return {throttled, flush, cancel};
};
