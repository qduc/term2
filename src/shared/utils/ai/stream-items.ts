/** Select provider items from a completed run, preferring this run's additions over full history. */
export function selectAgentStreamItems(stream: {
  output: unknown[];
  newItems: unknown[];
  history: unknown[];
}): unknown[] {
  const output = projectProviderItems(Array.isArray(stream.output) ? stream.output : []);
  const newItems = projectProviderItems(Array.isArray(stream.newItems) ? stream.newItems : []);
  const history = Array.isArray(stream.history) ? stream.history : [];
  return newItems.length > 0 ? newItems : output.length > 0 ? output : history;
}

function projectProviderItems(items: readonly unknown[]): unknown[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (event.type === 'item' && event.item && typeof event.item === 'object') return [event.item];
    if (
      event.type === 'text_delta' ||
      event.type === 'reasoning_started' ||
      event.type === 'reasoning_delta' ||
      event.type === 'model_attempt_rollback' ||
      event.type === 'codex_rate_limits' ||
      event.type === 'tool_call_streaming_delta' ||
      event.type === 'context_compaction_started' ||
      event.type === 'context_compaction_completed' ||
      event.type === 'usage_update' ||
      event.type === 'cost_update' ||
      event.type === 'run_budget'
    ) {
      return [];
    }
    return [item];
  });
}
