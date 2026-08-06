/**
 * Provider-facing transcript item owned by the application.
 *
 * Providers intentionally retain fields that are not part of the canonical
 * assistant-turn contract (for example native response IDs and metadata).
 * The run loop may add more fields as it adapts a provider, so this shape is
 * open rather than tied to one transport's item union.
 */
export interface ProviderInputItem {
  type?: unknown;
  role?: unknown;
  id?: unknown;
  callId?: unknown;
  call_id?: unknown;
  tool_call_id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
  content?: unknown;
  providerData?: Record<string, unknown>;
  /**
   * Marks an item as provider-native and opaque. Set only by the adapter that
   * produced the item; the run loop carries the item through untouched and no
   * other provider may re-serialize it. Absent for all application-modeled
   * items.
   */
  providerOpaque?: { provider: string };
  [key: string]: unknown;
}

export type ProviderInput = string | ProviderInputItem | ProviderInputItem[];
