export type ThrottledFunction<Args extends unknown[]> = {
  throttled: (...args: Args) => void;
  flush: () => void;
  cancel: () => void;
};

export type ThrottleScheduler = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timeout: ReturnType<typeof setTimeout>) => void;
};

const defaultScheduler: ThrottleScheduler = {
  now: Date.now,
  setTimeout,
  clearTimeout,
};

export const createThrottledFunction = <Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
  scheduler: ThrottleScheduler = defaultScheduler,
): ThrottledFunction<Args> => {
  let lastCallTime = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const invoke = () => {
    if (!pendingArgs) return;
    const args = pendingArgs;
    pendingArgs = null;
    lastCallTime = scheduler.now();
    fn(...args);
  };

  const schedule = (delayMs: number) => {
    if (timeout) return;
    timeout = scheduler.setTimeout(() => {
      timeout = null;
      invoke();
    }, delayMs);
  };

  const throttled = (...args: Args) => {
    pendingArgs = args;
    if (timeout) return;
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
