import type { ApplicationRunEvent } from '../contracts/application-stream.js';
import type { ProviderInputItem } from '../contracts/provider-input.js';
import { extractUsage } from '../utils/ai/token-usage.js';

export interface LegacyAgentEventState {
  toolNames: Map<number | string, string>;
  toolArgumentChars: Map<number | string, number>;
}

/** Normalize one old Agents-style runner event at the sole runtime ingress. */
export function normalizeLegacyAgentEvent(
  raw: unknown,
  state: LegacyAgentEventState = {
    toolNames: new Map(),
    toolArgumentChars: new Map(),
  },
): ApplicationRunEvent[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const event = raw as Record<string, any>;
  const directType = typeof event.type === 'string' ? event.type : undefined;
  const out: ApplicationRunEvent[] = [];
  if (directType === 'text_delta' && typeof event.text === 'string') {
    return withUsage(raw, { type: 'text_delta', text: event.text });
  }
  if (directType === 'output_text_delta' || directType === 'response.output_text.delta') {
    const text = coerceTextDelta(event);
    if (text) return withUsage(raw, { type: 'text_delta', text });
    // Some legacy wrappers copy the provider event type onto the outer
    // envelope while keeping the actual payload under data.event.
  }
  if (directType === 'reasoning_delta' && typeof event.text === 'string') {
    return withUsage(raw, { type: 'reasoning_delta', text: event.text });
  }
  if (directType === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
    return withUsage(raw, { type: 'reasoning_delta', text: event.delta });
  }
  if (directType === 'codex_rate_limits' && event.rateLimits) {
    return [{ type: 'codex_rate_limits', rateLimits: event.rateLimits }];
  }
  if (directType === 'codex.rate_limits') {
    const rateLimits = isRecord(event.rate_limits) ? event.rate_limits : event;
    return [{ type: 'codex_rate_limits', rateLimits: rateLimits as any }];
  }
  if (directType === 'tool-input-start') {
    if ((typeof event.id === 'string' || typeof event.id === 'number') && typeof event.toolName === 'string') {
      state.toolNames.set(event.id, event.toolName);
      state.toolArgumentChars.set(event.id, 0);
    }
    return out;
  }
  if (
    directType === 'tool-input-delta' &&
    typeof event.delta === 'string' &&
    event.delta.length > 0 &&
    (typeof event.id === 'string' || typeof event.id === 'number')
  ) {
    const previous = state.toolArgumentChars.get(event.id) ?? 0;
    const next = previous + event.delta.length;
    state.toolArgumentChars.set(event.id, next);
    return [{ type: 'tool_call_streaming_delta', toolName: state.toolNames.get(event.id), argumentCharCount: next }];
  }
  if (directType === 'tool_call_streaming_delta' && typeof event.argumentCharCount === 'number') {
    return [
      { type: 'tool_call_streaming_delta', toolName: event.toolName, argumentCharCount: event.argumentCharCount },
    ];
  }
  if (directType === 'item' && isRecord(event.item)) return [{ type: 'item', item: event.item }];
  if (directType === 'usage_update' && event.usage) return [{ type: 'usage_update', usage: event.usage }];

  const usage = extractUsage(raw);
  if (usage) out.push({ type: 'usage_update', usage });
  if (directType === 'run_item_stream_event' && isRecord(event.item)) {
    out.push({ type: 'item', item: event.item });
    return out;
  }
  if (directType === 'tool_call_output_item' && isRecord(event.rawItem)) {
    out.push({ type: 'item', item: event.rawItem });
    return out;
  }

  const data = isRecord(event.data) ? event.data : undefined;
  const nested = isRecord(data?.event) ? data.event : isRecord(event.event) ? event.event : data;
  if (!nested) return out;
  const type = typeof nested.type === 'string' ? nested.type : undefined;
  if (type === 'codex.rate_limits') {
    const rateLimits = isRecord(nested.rate_limits) ? nested.rate_limits : nested;
    out.push({ type: 'codex_rate_limits', rateLimits: rateLimits as any });
    return out;
  }
  if (type === 'output_text_delta' || type === 'response.output_text.delta') {
    const text = coerceTextDelta(nested);
    if (text) out.push({ type: 'text_delta', text });
    return out;
  }
  if (type === 'reasoning-delta' && typeof nested.delta === 'string') {
    out.push({ type: 'reasoning_delta', text: nested.delta });
    return out;
  }
  if (type === 'response.reasoning_summary_text.delta' && typeof nested.delta === 'string') {
    out.push({ type: 'reasoning_delta', text: nested.delta });
    return out;
  }
  if (type === 'tool-input-start') {
    if ((typeof nested.id === 'string' || typeof nested.id === 'number') && typeof nested.toolName === 'string') {
      state.toolNames.set(nested.id, nested.toolName);
      state.toolArgumentChars.set(nested.id, 0);
    }
    return out;
  }
  if (type === 'tool-input-delta') {
    if ((typeof nested.id === 'string' || typeof nested.id === 'number') && typeof nested.delta === 'string') {
      const previous = state.toolArgumentChars.get(nested.id) ?? 0;
      const next = previous + nested.delta.length;
      state.toolArgumentChars.set(nested.id, next);
      out.push({
        type: 'tool_call_streaming_delta',
        toolName: state.toolNames.get(nested.id),
        argumentCharCount: next,
      });
    }
    return out;
  }
  if (type === 'response.output_item.done' && isRecord(nested.item)) {
    out.push({ type: 'item', item: nested.item });
    return out;
  }
  if (type === 'response.output_item.added') {
    const item = isRecord(nested.output_item) ? nested.output_item : isRecord(nested.item) ? nested.item : undefined;
    if (!item) return out;
    if (item.type === 'function_call' && typeof item.name === 'string') {
      const index = typeof nested.output_index === 'number' ? nested.output_index : -1;
      if (index >= 0) {
        state.toolNames.set(index, item.name);
        state.toolArgumentChars.set(index, 0);
      }
    }
    return out;
  }
  if (
    type === 'response.function_call_arguments.delta' ||
    type === 'response.custom_tool_call_input.delta' ||
    type === 'response.mcp_call_arguments.delta'
  ) {
    if (typeof nested.delta === 'string' && nested.delta.length > 0 && typeof nested.output_index === 'number') {
      const index = nested.output_index;
      if (index < 0) return out;
      const previous = state.toolArgumentChars.get(index) ?? 0;
      const next = previous + nested.delta.length;
      state.toolArgumentChars.set(index, next);
      out.push({ type: 'tool_call_streaming_delta', toolName: state.toolNames.get(index), argumentCharCount: next });
    }
    return out;
  }
  if (
    type === 'response.output_item.delta' &&
    isRecord(nested.delta) &&
    typeof nested.delta.arguments === 'string' &&
    nested.delta.arguments.length > 0 &&
    typeof nested.output_index === 'number' &&
    nested.output_index >= 0
  ) {
    const index = nested.output_index;
    const previous = state.toolArgumentChars.get(index) ?? 0;
    const next = previous + nested.delta.arguments.length;
    state.toolArgumentChars.set(index, next);
    out.push({ type: 'tool_call_streaming_delta', toolName: state.toolNames.get(index), argumentCharCount: next });
    return out;
  }

  const choices = nested.choices;
  if (Array.isArray(choices) || isRecord(choices)) {
    const choiceEntries = Array.isArray(choices) ? choices : Object.values(choices);
    for (const choice of choiceEntries) {
      const delta = isRecord(choice?.delta) ? choice.delta : undefined;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof reasoning === 'string') out.push({ type: 'reasoning_delta', text: reasoning });
      const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const call of toolCalls) {
        const fn = isRecord(call?.function) ? call.function : undefined;
        const index = call?.index;
        if (typeof index !== 'number' || index < 0) continue;
        if (typeof fn?.name === 'string') {
          state.toolNames.set(index, fn.name);
          state.toolArgumentChars.set(index, 0);
        }
        if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
          const previous = state.toolArgumentChars.get(index) ?? 0;
          const next = previous + fn.arguments.length;
          state.toolArgumentChars.set(index, next);
          out.push({
            type: 'tool_call_streaming_delta',
            toolName: state.toolNames.get(index),
            argumentCharCount: next,
          });
        }
      }
    }
  }
  return out;
}

export function normalizeLegacySnapshotItems(items: readonly unknown[]): unknown[] {
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (item.type === 'run_item_stream_event' && isRecord(item.item)) return [item.item];
    if (item.type === 'item' && isRecord(item.item)) return [item.item];
    if (item.type === 'tool_call_output_item' && isRecord(item.rawItem)) return [item.rawItem];
    if (
      item.type === 'raw_model_stream_event' ||
      item.type === 'model' ||
      item.type === 'text_delta' ||
      item.type === 'reasoning_delta' ||
      item.type === 'codex_rate_limits' ||
      item.type === 'tool_call_streaming_delta' ||
      item.type === 'usage_update'
    ) {
      return [];
    }
    return [item];
  });
}

function withUsage(raw: unknown, event: ApplicationRunEvent): ApplicationRunEvent[] {
  const usage = extractUsage(raw);
  return usage ? [{ type: 'usage_update', usage }, event] : [event];
}

function coerceTextDelta(event: Record<string, unknown>): string {
  const candidate = event.delta ?? event.output_text ?? event.text ?? event.content;
  return coerceText(candidate);
}

function coerceText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(coerceText).filter(Boolean).join('');
  if (isRecord(value)) {
    for (const key of ['text', 'value', 'content', 'delta']) {
      if (key in value) {
        const text = coerceText(value[key]);
        if (text) return text;
      }
    }
  }
  return '';
}

function isRecord(value: unknown): value is ProviderInputItem {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
