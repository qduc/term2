/** Codex native compaction through legacy's compactHistory. Legacy keeps that output verbatim. */
import { randomUUID } from 'node:crypto';
import type { Item, ItemId, Model, ModelRef } from './index.js';
import { ModelFailure, toModelFailure } from './failure.js';
import { itemToInput, withConversationTiming } from './provider-items.js';
import { foreignCompactionRefusal } from './history-compatibility.js';

export function codexCompact(
  ref: ModelRef,
  settings: { get(key: 'agent.transport'): string | undefined },
  turnModel: (transport: string) => Promise<{
    compactHistory?(request: {
      readonly input: readonly ReturnType<typeof itemToInput>[];
      readonly signal?: AbortSignal;
    }): Promise<{ readonly history: readonly unknown[] }>;
  }>,
): NonNullable<Model['compact']> {
  return async (request, signal, onDispatched) => {
    const transport = request.downgradeTransport ? 'http' : settings.get('agent.transport') ?? 'websocket';
    try {
      const refusal = foreignCompactionRefusal(request.input, ref.provider);
      if (refusal) throw new ModelFailure({ kind: 'invalid_request', retryable: false, message: refusal });
      const turn = await turnModel(transport);
      if (!turn.compactHistory) throw new Error('Codex compact endpoint is unavailable');
      signal.throwIfAborted();
      onDispatched?.();
      const { history } = await turn.compactHistory({
        input: request.input.flatMap((item) => withConversationTiming(item, itemToInput(item))),
        signal,
      });
      if (history.length === 0) throw new Error('Codex compact endpoint returned an empty history');
      return compactedHistoryToItems(history, ref.provider);
    } catch (error) {
      throw toModelFailure(error, signal);
    }
  };
}

function compactedHistoryToItems(history: readonly unknown[], providerId: string): Item[] {
  return history.map((entry) => {
    const { providerOpaque, ...record } = entry as Record<string, unknown> & {
      providerOpaque?: { provider?: string; sourceProvider?: string };
    };
    const id = `item_${randomUUID()}` as ItemId;
    return providerOpaque
      ? {
          type: 'provider_opaque',
          id,
          provider: providerOpaque.provider ?? providerId,
          ...(providerOpaque.sourceProvider ? { sourceProvider: providerOpaque.sourceProvider } : {}),
          item: record,
        }
      : { type: 'provider_input', id, provider: providerId, input: record };
  });
}
