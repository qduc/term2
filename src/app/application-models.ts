import type { ISessionContextService } from '../shared/service-interfaces.js';
/** Puts one session's provider traffic in that session's attribution scope. */
import type { Model, ModelEvent, ModelRegistry, ModelRequest, ModelAffinity } from '../model/index.js';
import type { EffortUpdatesRejection } from '../model/effort-fallback.js';
import type { DirectContextPort } from '../session/capabilities.js';

/** Runs an operation inside one session's traffic attribution. */
export type SessionScope = <T>(operation: () => T) => T;

/** Snapshot one logical session's traffic attribution, retained across generations. */
export function createSessionScope(contexts: ISessionContextService, id: string, startedAt: string): SessionScope {
  const context = { sessionId: id, sessionStartedAt: startedAt, promptCacheKey: id };
  return (operation) => contexts.runWithContext(context, operation);
}

/**
 * Session traffic attribution is an AsyncLocalStorage, and one host process runs
 * many sessions. The Session drains turns on its own stack, so no caller can
 * hold the scope open; it has to enter on every step of the provider stream.
 * Provider identity is a separate explicit request input; child/auxiliary
 * requests with their own affinity retain it. Native compaction follows both.
 */
export function withSessionScope(models: ModelRegistry, scope: SessionScope, affinity?: ModelAffinity): ModelRegistry {
  const identified = (request: ModelRequest): ModelRequest =>
    request.affinity || !affinity ? request : { ...request, affinity };
  const stream = (
    model: Model,
    request: ModelRequest,
    signal: AbortSignal,
    onDispatched?: () => void,
  ): AsyncIterable<ModelEvent> => ({
    [Symbol.asyncIterator]() {
      const events = scope(() => model.stream(identified(request), signal, onDispatched)[Symbol.asyncIterator]());
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
      return {
        ...model,
        stream: (request, signal, onDispatched) => stream(model, request, signal, onDispatched),
        ...(model.compact
          ? {
              compact: (request: ModelRequest, signal: AbortSignal, onDispatched?: () => void) =>
                scope(() => model.compact!(identified(request), signal, onDispatched)),
            }
          : {}),
      };
    },
  };
}

/**
 * Give a registry selection the session log as its one record of a refused effort marker
 * (model/effort-fallback.ts). The port is read late: it exists only once the session has started,
 * and a rebuilt registry or a resumed session reads back what the log already holds.
 */
export function withEffortRejection<T extends object>(
  selection: T,
  port: () => DirectContextPort | undefined,
): T & { readonly effortUpdatesRejection: EffortUpdatesRejection } {
  return {
    ...selection,
    effortUpdatesRejection: {
      rejected: () => port()?.read().effortUpdatesRejected === true,
      record() {
        const live = port();
        // A lost compare-and-swap (a goal change in between) is retried once against the new generation.
        for (let attempt = 0; live && attempt < 2; attempt++)
          if (live.commit(live.read().goal.generation, [{ type: 'effort_updates_rejected' }])) return;
      },
    },
  };
}
