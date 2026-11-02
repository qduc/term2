import { normalizeApplicationInput } from '../../../../source/services/agent-runtime/application-run-loop.js';
import type { ProviderInput, ProviderInputItem } from '../../../../source/contracts/provider-input.js';

/** Source events can contain raw provider-opaque outputs as well as source history items. */
export function convertSourceItems(input: ProviderInput | readonly ProviderInputItem[], provider: string): Item[] {
  if (typeof input === 'string') return normalizeApplicationInput(input).map((part) => inputToItem(part, provider));
  const entries: readonly ProviderInputItem[] = Array.isArray(input) ? input : [input as ProviderInputItem];
  return entries.flatMap((entry): Item[] => {
    if (
      entry.type === 'provider_opaque' &&
      typeof entry.provider === 'string' &&
      entry.item &&
      typeof entry.item === 'object' &&
      !Array.isArray(entry.item)
    ) {
      const output = entry as unknown as Extract<StreamedModelTurnOutput, { type: 'provider_opaque' }>;
      return [
        {
          type: 'provider_opaque',
          id: newItemId(),
          provider: output.provider || provider,
          ...(output.sourceProvider ? { sourceProvider: output.sourceProvider } : {}),
          item: output.item,
        },
      ];
    }
    return normalizeApplicationInput([entry]).map((part) => inputToItem(part, provider));
  });
}

import type {
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
} from '../../../../source/contracts/streamed-model-turn.js';
import type { Item, ItemId, ToolCallId } from '../../model/index.js';

let nextItemId = 0;
export const newItemId = (): ItemId => `adopted_${Date.now().toString(36)}_${(nextItemId++).toString(36)}` as ItemId;

function id(value: string | undefined): ItemId {
  return (value || newItemId()) as ItemId;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeDataImage(image: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image);
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

export function inputToItem(input: StreamedModelTurnInput, provider: string): Item {
  switch (input.type) {
    case 'message': {
      const canRepresentContent = input.content.every(
        (part) => part.type === 'text' || (typeof part.image === 'string' && decodeDataImage(part.image) !== undefined),
      );
      if (input.role === 'system' || !canRepresentContent)
        return {
          type: 'provider_input',
          id: newItemId(),
          provider,
          input: input as unknown as Readonly<Record<string, unknown>>,
        };
      const content = input.content.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text };
        const decoded = decodeDataImage(part.image as string)!;
        return { type: 'image' as const, ...decoded, ...(part.detail ? { detail: part.detail } : {}) };
      });
      return input.role === 'user'
        ? { type: 'user_message', id: newItemId(), content }
        : { type: 'assistant_message', id: newItemId(), content };
    }
    case 'reasoning':
      return {
        type: 'reasoning',
        id: id(input.id),
        ...(input.id !== undefined ? { providerItemId: input.id } : {}),
        summary: input.text,
        ...(input.providerMetadata ? { providerMetadata: input.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(input.arguments);
      return {
        type: 'tool_call',
        id: id(input.id),
        callId: input.id as ToolCallId,
        toolName: input.name,
        input: parsed,
        rawArguments: input.arguments,
        argumentsSnapshot: parsed,
        ...(input.providerMetadata ? { providerMetadata: input.providerMetadata } : {}),
        ...(input.toolType ? { toolType: input.toolType } : {}),
      };
    }
    case 'tool_result':
      if (typeof input.output !== 'string')
        return {
          type: 'provider_input',
          id: newItemId(),
          provider,
          input: input as unknown as Readonly<Record<string, unknown>>,
        };
      return {
        type: 'tool_result',
        id: newItemId(),
        callId: input.id as ToolCallId,
        output: input.output,
        isError: false,
        ...(input.toolType ? { toolType: input.toolType } : {}),
      };
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        id: newItemId(),
        provider: input.provider,
        ...(input.sourceProvider ? { sourceProvider: input.sourceProvider } : {}),
        item: input.item,
      };
  }
}
