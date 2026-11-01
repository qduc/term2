import type {
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelTurnEvent,
  StreamedModelToolResultPart,
} from '../../../../source/contracts/streamed-model-turn.js';
import type { Item, ItemId, ModelError, ModelRequest, ToolCallId } from '../index.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let nextItemId = 0;
export const newItemId = (): ItemId => `adopted_${Date.now().toString(36)}_${(nextItemId++).toString(36)}` as ItemId;

function id(value: string | undefined): ItemId {
  return (value || newItemId()) as ItemId;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
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

function isToolResultParts(
  value: readonly Readonly<Record<string, unknown>>[],
): value is readonly StreamedModelToolResultPart[] {
  return (
    value.length > 0 &&
    value.every((part) => {
      if (part.type === 'text') return typeof part.text === 'string';
      if (part.type === 'image') {
        if (!('image' in part)) return false;
        const image = part.image;
        if (typeof image === 'string' || image === undefined) return true;
        if (!isRecord(image)) return false;
        return (
          typeof image.id === 'string' ||
          typeof image.url === 'string' ||
          typeof image.fileId === 'string' ||
          typeof image.data === 'string' ||
          image.data instanceof Uint8Array
        );
      }
      if (part.type === 'file') {
        if (!('file' in part)) return false;
        const file = part.file;
        if (typeof file === 'string') return true;
        if (!isRecord(file)) return false;
        return (
          typeof file.id === 'string' ||
          typeof file.url === 'string' ||
          ((typeof file.data === 'string' || file.data instanceof Uint8Array) &&
            typeof file.mediaType === 'string' &&
            typeof file.filename === 'string')
        );
      }
      return false;
    })
  );
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

export function itemToInput(item: Item): StreamedModelTurnInput {
  switch (item.type) {
    case 'provider_input':
      return item.input as unknown as StreamedModelTurnInput;
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        provider: item.provider,
        ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
        item: item.item,
      };
    case 'user_message':
    case 'assistant_message':
      return {
        type: 'message',
        role: item.type === 'user_message' ? 'user' : 'assistant',
        content: item.content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : {
                type: 'image',
                image: `data:${part.mediaType};base64,${part.data}`,
                ...(part.detail ? { detail: part.detail } : {}),
              },
        ),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        ...(item.providerItemId !== undefined ? { id: item.providerItemId } : {}),
        text: item.summary,
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    case 'tool_call': {
      const argumentsText =
        item.rawArguments !== undefined && sameJson(item.input, item.argumentsSnapshot)
          ? item.rawArguments
          : JSON.stringify(item.input ?? {});
      return {
        type: 'tool_call',
        id: item.callId,
        name: item.toolName,
        arguments: argumentsText ?? 'null',
        ...(item.toolType ? { toolType: item.toolType } : {}),
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: item.callId,
        output: item.providerOutput && isToolResultParts(item.providerOutput) ? item.providerOutput : item.output,
        ...(item.toolType ? { toolType: item.toolType } : {}),
      };
    case 'summary':
      return { type: 'message', role: 'user', content: [{ type: 'text', text: item.text }] };
  }
}

export function outputToItem(
  output: StreamedModelTurnOutput | Extract<StreamedModelTurnEvent, { type: 'tool_call' }>,
  provider: string,
): Item {
  switch (output.type) {
    case 'message':
      return { type: 'assistant_message', id: newItemId(), content: output.content.map((part) => ({ ...part })) };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: id(output.id),
        ...(output.id !== undefined ? { providerItemId: output.id } : {}),
        summary: output.text,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(output.arguments);
      return {
        type: 'tool_call',
        id: id(output.id),
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
        provider: output.provider || provider,
        ...(output.sourceProvider ? { sourceProvider: output.sourceProvider } : {}),
        item: output.item,
      };
  }
}

export function toModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (
    isRecord(error) &&
    typeof error.kind === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean'
  )
    return error as unknown as ModelError;
  const message = error instanceof Error ? error.message : String(error);
  return { kind: signal?.aborted ? 'cancelled' : 'provider', message, retryable: false };
}

export const adoptedModelConversion = { inputToItem, itemToInput, outputToItem };
