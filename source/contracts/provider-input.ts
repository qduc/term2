/**
 * Provider-facing transcript item owned by the application.
 *
 * Providers intentionally retain fields that are not part of the canonical
 * assistant-turn contract (for example native response IDs and metadata).
 * The run loop may add more fields as it adapts a provider, so this shape is
 * open rather than tied to one transport's item union.
 */
export interface ContextSummaryMarker {
  readonly version: 1;
  readonly strategy: 'local';
  readonly replacesThroughRevision?: number;
  readonly sourceProvider?: string;
  readonly sourceModel?: string;
  readonly estimatedTokensBefore?: number;
  readonly estimatedTokensAfter?: number;
  readonly rearmAtEstimatedTokens?: number;
}

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
  /** Application-owned portable replacement checkpoint. */
  contextSummary?: ContextSummaryMarker;
  [key: string]: unknown;
}

export const isLocalContextSummary = (
  item: unknown,
): item is ProviderInputItem & { contextSummary: ContextSummaryMarker } => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const marker = (item as ProviderInputItem).contextSummary;
  return marker?.version === 1 && marker.strategy === 'local';
};

export type ProviderInput = string | ProviderInputItem | ProviderInputItem[];
