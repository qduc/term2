/** Explicit public DTO construction. Never spread provider items, settings or engine handles. */
import type { InteractionRequest } from '../engine/direct-types.js';
import type { Item } from '../model/index.js';
import { interactionQuestions } from './direct-questions.js';
import type { JsonValue, WireContent, WireInteraction, WireMessage } from './direct-wire.js';

/** Copy plain tool presentation/input into JSON data; no truncation or live objects. */
export function publicJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Public tool data must be JSON serializable');
  return JSON.parse(encoded) as JsonValue;
}
export function publicContent(content: readonly WireContent[]): readonly WireContent[] {
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', mediaType: part.mediaType, data: part.data, ...(part.detail ? { detail: part.detail } : {}) });
}
export function contentText(content: readonly WireContent[]): string {
  return content.map(part => part.type === 'text' ? part.text : '[image]').join('');
}
export function publicInteraction(request: InteractionRequest): WireInteraction {
  return {
    requestId: request.requestId, turnId: request.turnId,
    ...(request.executionId ? { executionId: request.executionId } : {}),
    ...(request.parentExecutionId ? { parentExecutionId: request.parentExecutionId } : {}),
    supportedGrants: [], ...(interactionQuestions(request) ? { questions: interactionQuestions(request) } : {}),
    kind: request.kind, toolName: request.toolName, input: publicJson(request.input), summary: request.summary,
    ...(request.detail !== undefined ? { detail: request.detail } : {}),
    ...(request.risk ? { risk: request.risk } : {}),
    ...(request.presentation ? { presentation: publicJson(request.presentation) as NonNullable<WireInteraction['presentation']> } : {}),
  };
}
/** Opaque provider/reasoning/call items are never exposed as transcript messages. */
export function publicMessage(item: Item, turnId: string, modelStep?: number, executionId?: string): WireMessage | null {
  if (item.type === 'user_message' || item.type === 'assistant_message') {
    const content = publicContent(item.content);
    return { id: item.id, role: item.type === 'user_message' ? 'user' : 'assistant', content,
      text: contentText(content), turnId, ...(modelStep !== undefined ? { modelStep } : {}) };
  }
  return null;
}

/** Normalize only known tool-result text/image parts, not opaque provider frames. */
export function publicToolContent(parts: readonly Readonly<Record<string, unknown>>[] | undefined): readonly WireContent[] | undefined {
  if (!parts) return undefined;
  const content: WireContent[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
    if (part.type === 'image' && part.image && typeof part.image === 'object') {
      const image = part.image as Record<string, unknown>;
      if (typeof image.data === 'string' && typeof image.mediaType === 'string') {
        content.push({ type: 'image', data: image.data, mediaType: image.mediaType });
      }
    }
  }
  return content;
}
