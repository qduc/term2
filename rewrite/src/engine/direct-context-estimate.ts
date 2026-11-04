/**
 * Legacy's context estimate (source context-compaction estimateContext): ceil(bytes / 4) of the JSON of
 * { instructions, tools, history } in legacy's own request shapes. The user reads these numbers ("Context
 * compacted locally (A → B estimated tokens)"), and they also drive the compaction triggers and the hot-tail cut,
 * so next counts its request in those shapes. Only the estimate uses them; nothing is sent in this form.
 */
import type { Item, ModelRequest, ToolSpec } from '../model/index.js';

export type DirectContextEstimate = {
  readonly renderedInputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly hardFitTokens: number;
};

/** Legacy stores the time a person typed each message; its estimate counts that ISO stamp's bytes. */
const HUMAN_INPUT_AT = new Date(0).toISOString();
/** Host-written user messages carry no humanInputAt in legacy. */
const HOST_USER_MESSAGE = /^compact_request_/;
/** The engine names a tool result `<turnId>:exec:<n>:result`; legacy tags both halves with the turn. */
const RESULT_ID = /^(.+):exec:\d+:result$/;

function legacyContent(parts: Extract<Item, { type: 'user_message' }>['content'], textType: string): unknown {
  if (parts.length === 1 && parts[0]!.type === 'text' && textType === 'input_text') return parts[0]!.text;
  return parts.map((part) =>
    part.type === 'text'
      ? { type: textType, text: part.text }
      : { type: 'input_image', image: `data:${part.mediaType};base64,${part.data}` },
  );
}

/** History as legacy's ProviderInputItem list (user/assistant/system messages, function calls and results). */
export function legacyEstimateHistory(history: readonly Item[]): unknown[] {
  const turnOf = new Map<string, string>();
  const names = new Map<string, string>();
  for (const item of history) {
    if (item.type === 'tool_call') names.set(item.callId, item.toolName);
    const turn = item.type === 'tool_result' ? RESULT_ID.exec(item.id)?.[1] : undefined;
    if (item.type === 'tool_result' && turn) turnOf.set(item.callId, turn);
  }
  const occurrences = new Map<string, number>();
  // Legacy tags a call with its turn and ordinal once the turn settles it; an open call has neither.
  const tags = (callId: string, opens: boolean) => {
    const turnId = turnOf.get(callId);
    if (!turnId) return {};
    const key = `${turnId ?? ''}\u0000${callId}`;
    const occurrence = (occurrences.get(key) ?? 0) + (opens || !occurrences.has(key) ? 1 : 0);
    occurrences.set(key, occurrence);
    return { ...(turnId ? { turnId } : {}), occurrence };
  };
  return history.flatMap((item): unknown[] => {
    switch (item.type) {
      case 'user_message':
        return [
          {
            role: 'user',
            type: 'message',
            content: legacyContent(item.content, 'input_text'),
            ...(HOST_USER_MESSAGE.test(item.id) ? {} : { humanInputAt: HUMAN_INPUT_AT }),
          },
        ];
      case 'assistant_message':
        return [{ type: 'message', role: 'assistant', content: legacyContent(item.content, 'output_text') }];
      case 'summary':
        return [{ role: 'system', type: 'message', content: item.text }];
      case 'tool_call':
        return [
          {
            type: 'function_call',
            callId: item.callId,
            name: item.toolName,
            arguments: item.rawArguments ?? JSON.stringify(item.input ?? {}),
            ...tags(item.callId, true),
          },
        ];
      case 'tool_result':
        return [
          {
            type: 'function_call_result',
            callId: item.callId,
            name: names.get(item.callId) ?? 'unknown',
            output: item.output,
            ...tags(item.callId, false),
          },
        ];
      case 'reasoning':
        // Legacy's estimate drops opaque reasoning; a readable summary is the only part it would count.
        return item.summary ? [{ type: 'reasoning', content: [{ type: 'input_text', text: item.summary }] }] : [];
      default:
        return [item.type === 'provider_input' ? item.input : item.item];
    }
  });
}

/** Tool declarations as legacy's request context holds them. */
function legacyTools(tools: readonly ToolSpec[] | undefined): unknown[] {
  return (tools ?? []).map((tool) =>
    tool.modelTool
      ? { type: 'custom', name: tool.name, description: tool.description, format: tool.modelTool.format }
      : { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema },
  );
}

export function legacyEstimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/** Conservative bytes/4 estimate with the existing 10% capacity reserve. Never changes history. */
export function estimateDirectContext(request: ModelRequest, contextWindow?: number): DirectContextEstimate {
  const renderedInputTokens = Math.ceil(
    legacyEstimateBytes({
      instructions: request.instructions ?? '',
      tools: legacyTools(request.tools),
      history: legacyEstimateHistory(request.input),
    }) / 4,
  );
  const outputReserveTokens = Math.max(0, Math.ceil(request.maxOutputTokens ?? 0));
  const safetyReserveTokens = Math.ceil((contextWindow ?? 0) * 0.1);
  return {
    renderedInputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    hardFitTokens: renderedInputTokens + outputReserveTokens + safetyReserveTokens,
  };
}
