type TaskRunner<T> = () => Promise<T>;

type QueueEntry<T> = {
  task: TaskRunner<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  started: boolean;
};

function createAbortError(): Error {
  const error = new Error('The user aborted a request.');
  error.name = 'AbortError';
  return error;
}

function toPositiveIntegerLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 3;
  }

  return Math.max(1, Math.floor(limit));
}

/**
 * FIFO concurrency limiter for tool execution.
 *
 * The limiter reads the maximum allowed concurrency from a callback so the
 * active limit can change at runtime without recreating the limiter.
 */
export class ToolExecutionLimiter {
  #activeCount = 0;
  #queue: Array<QueueEntry<any>> = [];

  constructor(private readonly getLimit: () => number) {}

  notifyLimitChanged(): void {
    this.#drainQueue();
  }

  run<T>(task: TaskRunner<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        signal,
        started: false,
      };

      const resolveOnce = (value: T | PromiseLike<T>) => {
        if (entry.started === false && entry.onAbort) {
          signal?.removeEventListener('abort', entry.onAbort);
          entry.onAbort = undefined;
        }
        resolve(value);
      };

      const rejectOnce = (reason?: unknown) => {
        if (entry.started === false && entry.onAbort) {
          signal?.removeEventListener('abort', entry.onAbort);
          entry.onAbort = undefined;
        }
        reject(reason);
      };

      entry.resolve = resolveOnce;
      entry.reject = rejectOnce;

      if (signal?.aborted) {
        rejectOnce(createAbortError());
        return;
      }

      if (signal) {
        entry.onAbort = () => {
          if (entry.started) {
            return;
          }

          this.#removeQueuedEntry(entry);
          rejectOnce(createAbortError());
          this.#drainQueue();
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.#queue.push(entry);
      this.#drainQueue();
    });
  }

  #removeQueuedEntry(entry: QueueEntry<any>): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  #drainQueue(): void {
    const limit = toPositiveIntegerLimit(this.getLimit());

    while (this.#activeCount < limit && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (!next) {
        break;
      }

      if (next.signal?.aborted) {
        next.reject(createAbortError());
        continue;
      }

      next.started = true;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.onAbort = undefined;
      }

      this.#activeCount++;
      void this.#runEntry(next);
    }
  }

  async #runEntry<T>(entry: QueueEntry<T>): Promise<void> {
    try {
      const result = await entry.task();
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      this.#activeCount--;
      this.#drainQueue();
    }
  }
}
