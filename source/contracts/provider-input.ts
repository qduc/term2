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
  [key: string]: unknown;
}

export type ProviderInput = string | ProviderInputItem | ProviderInputItem[];
