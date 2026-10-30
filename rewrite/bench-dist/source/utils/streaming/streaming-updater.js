import { createThrottledFunction } from '../throttle.js';
export const createStreamingUpdateCoordinator = (onUpdate, intervalMs, scheduler) => {
    let lastEmitted = null;
    const throttled = createThrottledFunction((...args) => {
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
    }, intervalMs, scheduler);
    const push = (...args) => {
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
//# sourceMappingURL=streaming-updater.js.map