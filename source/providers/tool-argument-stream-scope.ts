/** Response-local identity evidence shared by the OpenAI and Codex stream readers. */
import type { StreamedModelToolArgumentScope } from '../contracts/streamed-model-turn.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * An added frame links the provider's output slot/item ID to its call ID.
 * Later argument frames often omit call_id. Remember only those explicit links,
 * within this response; never substitute an item ID/index for an absent call ID.
 * This helper does not count, buffer or reconstruct argument bytes.
 */
export class ResponseToolArgumentScopes {
  readonly #scopes = new Map<string | number, StreamedModelToolArgumentScope>();

  observe(raw: unknown): StreamedModelToolArgumentScope {
    const event = record(raw);
    const item = record(event?.output_item) ?? record(event?.item);
    const callIndex = typeof event?.output_index === 'number' ? event.output_index : undefined;
    const itemId = text(event?.item_id) ?? text(item?.id);
    const callId = text(event?.call_id) ?? text(item?.call_id);
    const keys = [itemId, callIndex, callId].filter((key): key is string | number => key !== undefined);
    const previous = keys.map((key) => this.#scopes.get(key)).find((scope) => scope !== undefined);
    const scope = {
      ...previous,
      ...(callId !== undefined ? { callId } : {}),
      ...(itemId !== undefined ? { itemId } : {}),
      ...(callIndex !== undefined ? { callIndex } : {}),
    };
    for (const key of keys) this.#scopes.set(key, scope);
    return scope;
  }
}
