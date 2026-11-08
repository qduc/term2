import { AsyncLocalStorage } from 'node:async_hooks';
/** Bridges portable request identity into the retained providers' context API. */
import { randomUUID } from 'node:crypto';
import type { ModelAffinity } from '../../index.js';
import type { ISessionContextService, SessionTrafficContext } from '../../../shared/service-interfaces.js';

export function requestTrafficContext(
  affinity: ModelAffinity | undefined,
  telemetry?: Pick<
    SessionTrafficContext,
    'sessionStartedAt' | 'mode' | 'traceId' | 'firstUserMessagePreview' | 'evaluator' | 'rootContextCompaction'
  > | null,
): SessionTrafficContext {
  // An unscoped Model request is independent, even when a caller happens to be
  // inside an application session. Reuse this snapshot for its retries.
  const conversationKey = affinity?.conversationKey ?? randomUUID();
  return {
    sessionId: conversationKey,
    sessionStartedAt: telemetry?.sessionStartedAt ?? '',
    ...(telemetry?.mode !== undefined ? { mode: telemetry.mode } : {}),
    ...(telemetry?.traceId !== undefined ? { traceId: telemetry.traceId } : {}),
    ...(telemetry?.firstUserMessagePreview !== undefined
      ? { firstUserMessagePreview: telemetry.firstUserMessagePreview }
      : {}),
    ...(telemetry?.evaluator !== undefined ? { evaluator: telemetry.evaluator } : {}),
    ...(telemetry?.rootContextCompaction !== undefined
      ? { rootContextCompaction: telemetry.rootContextCompaction }
      : {}),
    providerHistoryKey: conversationKey,
    ...(affinity?.cacheKey ? { promptCacheKey: affinity.cacheKey } : {}),
    providerRoutingKey: affinity?.routingKey ?? affinity?.cacheKey ?? conversationKey,
  };
}

/** Both traffic metadata and physical-dispatch observation belong to this registry instance. */
export class ProviderRequestScope implements ISessionContextService {
  readonly #storage = new AsyncLocalStorage<{ context: SessionTrafficContext; onDispatched?: () => void }>();

  getContext(): SessionTrafficContext | null {
    return this.#storage.getStore()?.context ?? null;
  }
  runWithContext<T>(context: SessionTrafficContext, operation: () => T): T {
    return this.#storage.run({ context, onDispatched: this.#storage.getStore()?.onDispatched }, operation);
  }
  runRequest<T>(context: SessionTrafficContext, onDispatched: () => void, operation: () => T): T {
    return this.#storage.run({ context, onDispatched }, operation);
  }
  dispatched(): void {
    this.#storage.getStore()?.onDispatched?.();
  }
}
