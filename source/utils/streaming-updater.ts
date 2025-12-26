import {createThrottledFunction} from './throttle.js';

export type StreamingUpdateCoordinator<Args extends unknown[]> = {
    push: (...args: Args) => void;
    flush: () => void;
    cancel: () => void;
};

export const createStreamingUpdateCoordinator = <Args extends unknown[]>(
    onUpdate: (...args: Args) => void,
    intervalMs: number,
): StreamingUpdateCoordinator<Args> => {
    let lastEmitted: Args | null = null;

    const throttled = createThrottledFunction((...args: Args) => {
        if (lastEmitted && args.length === lastEmitted.length) {
            let isDuplicate = true;
            for (let i = 0; i < args.length; i += 1) {
                if (args[i] !== lastEmitted[i]) {
                    isDuplicate = false;
                    break;
                }
            }
            if (isDuplicate) {
                return;
            }
        }
        lastEmitted = args;
        onUpdate(...args);
    }, intervalMs);

    const push = (...args: Args) => {
        if (lastEmitted && args.length === lastEmitted.length) {
            let isDuplicate = true;
            for (let i = 0; i < args.length; i += 1) {
                if (args[i] !== lastEmitted[i]) {
                    isDuplicate = false;
                    break;
                }
            }
            if (isDuplicate) {
                return;
            }
        }
        throttled.throttled(...args);
    };

    return {
        push,
        flush: throttled.flush,
        cancel: throttled.cancel,
    };
};
