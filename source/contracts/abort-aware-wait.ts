/** Observe a pending read even after its owner stops waiting for it. */
export function waitForAbortableRead<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  onDetached?: (operation: Promise<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let operationSettled = false;
    const observed = Promise.resolve(operation);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      if (!settled && !operationSettled) onDetached?.(observed);
      finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
    };
    observed.then(
      (value) => {
        operationSettled = true;
        finish(() => resolve(value));
      },
      (error) => {
        operationSettled = true;
        finish(() => reject(error));
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
