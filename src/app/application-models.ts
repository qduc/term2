/** Puts one session's provider traffic in that session's attribution scope. */
import type { Model, ModelEvent, ModelRegistry, ModelRequest } from '../model/index.js';

/** Runs an operation inside one session's traffic attribution. */
export type SessionScope = <T>(operation: () => T) => T;

/**
 * Session traffic attribution is an AsyncLocalStorage, and one host process runs
 * many sessions. The Session drains turns on its own stack, so no caller can
 * hold the scope open; it has to enter on every step of the provider stream.
 */
export function withSessionScope(models: ModelRegistry, scope: SessionScope): ModelRegistry {
  const stream = (
    model: Model,
    request: ModelRequest,
    signal: AbortSignal,
    onDispatched?: () => void,
  ): AsyncIterable<ModelEvent> => ({
    [Symbol.asyncIterator]() {
      const events = scope(() => model.stream(request, signal, onDispatched)[Symbol.asyncIterator]());
      return {
        next: () => scope(() => events.next()),
        return: (value?: unknown) => scope(() => events.return?.(value) ?? Promise.resolve({ done: true, value })),
      };
    },
  });
  return {
    list: () => models.list(),
    resolve(ref) {
      const model = models.resolve(ref);
      return { ...model, stream: (request, signal, onDispatched) => stream(model, request, signal, onDispatched) };
    },
  };
}
