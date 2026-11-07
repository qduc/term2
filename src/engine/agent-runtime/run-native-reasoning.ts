import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
import type { StreamedModelProviderOptions, StreamedModelTurnInput } from '../../model/streamed-model-turn.js';
import { type AgentStream } from '../agent-stream.js';
import { EventQueue, outputPush } from './run-segment-events.js';
import type { RunState } from './run-state.js';
export type PendingNativeReasoning = {
  id?: string;
  text: string;
  providerMetadata: StreamedModelProviderOptions;
};

/**
 * Only replay native reasoning when the provider explicitly supplies the
 * Chat-Completions continuation field. Generic reasoning remains display-only
 * so providers with different native formats are not given a foreign field.
 */
/**
 * True when any lane namespace in the metadata carries an `encrypted_content`
 * blob — the shape every Responses adapter produces, whichever vendor it is.
 */
function hasNamespacedEncryptedReasoning(metadata: StreamedModelProviderOptions | undefined): boolean {
  if (!metadata) return false;
  return Object.values(metadata).some((value) => asRecord(value)?.encrypted_content !== undefined);
}

export function appendNativeReasoning(
  current: PendingNativeReasoning | undefined,
  event: {
    readonly id?: string;
    readonly text: string;
    readonly providerMetadata?: StreamedModelProviderOptions;
  },
): PendingNativeReasoning | undefined {
  const nativeReasoning = event.providerMetadata?.reasoning_content;
  if (typeof nativeReasoning === 'string') {
    const text =
      current?.text === nativeReasoning
        ? current.text
        : current?.text && nativeReasoning.startsWith(current.text)
        ? nativeReasoning
        : `${current?.text ?? ''}${nativeReasoning}`;
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text,
      providerMetadata: { ...event.providerMetadata, reasoning_content: text },
    };
  }
  // Responses providers return encrypted reasoning only on their terminal
  // output. Their metadata is namespaced, so retain it without turning it into
  // the Chat-Completions-only reasoning_content convention. Match on the
  // namespaced shape rather than an allowlist of lane names: an allowlist
  // silently drops the reasoning of every Responses lane added later.
  if (hasNamespacedEncryptedReasoning(event.providerMetadata)) {
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text: event.text,
      providerMetadata: event.providerMetadata!,
    };
  }
  return current;
}

export function commitPendingNativeReasoning(
  state: RunState,
  stream: AgentStream,
  queue: EventQueue,
  pending: PendingNativeReasoning | undefined,
): undefined {
  if (!pending) return undefined;
  const reasoningInput: StreamedModelTurnInput = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    text: pending.text,
    providerMetadata: pending.providerMetadata,
  };
  const reasoningHistory: ProviderInputItem = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    content: [{ type: 'reasoning_text', text: pending.text }],
    providerData: pending.providerMetadata,
  };
  state.input.push(reasoningInput);
  state.history.push(reasoningHistory);
  outputPush(stream, queue, { type: 'item', item: reasoningHistory });
  return undefined;
}
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}
