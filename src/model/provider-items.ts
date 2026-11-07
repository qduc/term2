/** Portable Item/provider shapes. No execution, persistence or retries. */
import { randomUUID } from 'node:crypto';
import type {
  StreamedModelToolDefinition,
  StreamedModelToolResultPart,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelUsage,
} from './streamed-model-turn.js';
import type { Item, ItemId, StopReason, ToolCallId, ToolSpec, Usage } from './index.js';
import { ModelFailure } from './failure.js';
import { foreignCompactionRefusal } from './history-compatibility.js';

export function toolDefinition(tool: ToolSpec): StreamedModelToolDefinition {
  return tool.modelTool
    ? {
        type: tool.modelTool.type,
        name: tool.name,
        description: tool.description,
        format: tool.modelTool.format,
      }
    : {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      };
}

// ---------- Item -> provider input ----------

/** Refuse lossy native compaction before translating either stream or compact input. */
export function historyToInput(history: readonly Item[], provider: string): StreamedModelTurnInput[] {
  const refusal = foreignCompactionRefusal(history, provider);
  if (refusal) throw new ModelFailure({ kind: 'invalid_request', retryable: false, message: refusal });
  return history.flatMap((item) => withConversationTiming(item, itemToInput(item)));
}

/** Expand app-owned timing beside its user item only at the provider boundary. */
function withConversationTiming(item: Item, input: StreamedModelTurnInput): readonly StreamedModelTurnInput[] {
  return item.type === 'user_message' && item.conversationTiming
    ? [{ type: 'message', role: 'system', content: [{ type: 'text', text: item.conversationTiming }] }, input]
    : [input];
}

export function itemToInput(item: Item): StreamedModelTurnInput {
  switch (item.type) {
    case 'user_message':
    case 'assistant_message': {
      // Match source assistant context normalization without rewriting accepted
      // Items or live deltas. Mixed/media messages retain their exact parts.
      const content =
        item.type === 'assistant_message' && item.content.every((part) => part.type === 'text')
          ? [
              {
                type: 'text' as const,
                text: item.content
                  .map((part) => part.text)
                  .join('\n\n')
                  .trim(),
              },
            ]
          : item.content;
      return {
        type: 'message',
        role: item.type === 'user_message' ? 'user' : 'assistant',
        content: content.map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'image' as const,
                image: `data:${part.mediaType};base64,${part.data}`,
                ...(part.detail ? { detail: part.detail } : {}),
              },
        ),
      };
    }
    case 'reasoning':
      return {
        type: 'reasoning',
        ...(item.providerItemId !== undefined ? { id: item.providerItemId } : {}),
        text: item.summary,
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        provider: item.provider,
        ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
        item: item.item,
      };
    case 'provider_input':
      return item.input as unknown as StreamedModelTurnInput;
    case 'tool_call': {
      const unchanged = JSON.stringify(item.input) === JSON.stringify(item.argumentsSnapshot);
      return {
        type: 'tool_call',
        id: item.callId,
        name: item.toolName,
        arguments:
          item.rawArguments !== undefined && unchanged ? item.rawArguments : JSON.stringify(item.input ?? {}) ?? 'null',
        ...(item.toolType ? { toolType: item.toolType } : {}),
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: item.callId,
        // Tool adapters store provider-native parts; never coerce media to text
        // or silently replace structured output during continuation/reopen.
        output: item.providerOutput
          ? (item.providerOutput as unknown as readonly StreamedModelToolResultPart[])
          : item.output,
        ...(item.toolType ? { toolType: item.toolType } : {}),
      };
    case 'summary':
      // Legacy's compaction checkpoint is a system message in history (local-context-compactor.ts); its harness
      // notices ("[Mode Notice] ...") are user messages.
      return {
        type: 'message',
        role: item.text.startsWith(COMPACTION_CHECKPOINT_PREFIX) ? 'system' : 'user',
        content: [{ type: 'text', text: item.text }],
      };
  }
}

/** The opening of legacy's compaction checkpoint wrapper (src/engine/prompts/context-compaction.ts). */
const COMPACTION_CHECKPOINT_PREFIX = '[Compacted Conversation Context';

export function outputToItem(
  output: StreamedModelTurnOutput | Extract<StreamedModelTurnEvent, { type: 'tool_call' }>,
  providerId: string,
): Item {
  switch (output.type) {
    case 'message':
      return { type: 'assistant_message', id: newItemId(), content: output.content.map((part) => ({ ...part })) };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: output.id ? (output.id as ItemId) : newItemId(),
        ...(output.id !== undefined ? { providerItemId: output.id } : {}),
        summary: output.text,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(output.arguments);
      return {
        type: 'tool_call',
        id: output.id ? (output.id as ItemId) : newItemId(),
        callId: output.id as ToolCallId,
        toolName: output.name,
        input: parsed,
        rawArguments: output.arguments,
        argumentsSnapshot: parsed,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
        ...('toolType' in output && output.toolType ? { toolType: output.toolType } : {}),
      };
    }
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        id: newItemId(),
        provider: output.provider || providerId,
        ...(output.sourceProvider ? { sourceProvider: output.sourceProvider } : {}),
        item: output.item,
      };
  }
}

export function toUsage(usage: StreamedModelUsage): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

export function stopReason(reason: string | undefined): StopReason {
  if (reason === 'tool_calls' || reason === 'tool_use' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  return 'end_turn';
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function newItemId(): ItemId {
  return `item_${randomUUID()}` as ItemId;
}
