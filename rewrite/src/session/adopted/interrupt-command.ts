/** User interrupt command: cancels the foreground turn and the handle's background work together. */
import type { AdoptedCommandDeps } from './submission.js';

export function createInterruptCommand(
  deps: AdoptedCommandDeps,
  cancels: {
    /** Cancels the foreground turn and resolves once it has settled. */
    foreground: () => Promise<void>;
    /** Requests cancellation of source-owned background work; must be synchronous. */
    background?: () => void;
  },
) {
  const { context, turn } = deps;
  return {
    interruptFromUser(): Promise<void> {
      if (turn.closing || context.state().status === 'closed')
        return Promise.reject(new Error('Session handle is closed'));
      if (turn.interrupting) return turn.interrupting;
      if (!cancels.background) return Promise.reject(new Error('User interrupt is not supported'));
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const operation = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      turn.interrupting = operation;
      const foreground = cancels.foreground();
      void foreground.catch(() => {});
      let failure: unknown;
      let failed = false;
      try {
        const result: unknown = cancels.background();
        if (
          result != null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          void Promise.resolve(result).catch(() => {});
          throw new TypeError('Background cancellation must be synchronous');
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      void (async () => {
        try {
          await foreground;
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        if (failed) throw failure;
      })().then(
        () => {
          if (turn.interrupting === operation) turn.interrupting = undefined;
          resolve();
        },
        (error) => {
          if (turn.interrupting === operation) turn.interrupting = undefined;
          reject(error);
        },
      );
      return operation;
    },
  };
}
