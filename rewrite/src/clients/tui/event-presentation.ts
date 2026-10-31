import type { WireEvent } from '../../protocol/direct-wire.js';

export type LiveEvent = { readonly key: string; readonly text: string };

/** Keep only actual event payloads ignored by the shared read-model reducer; never infer state or ordering. */
export function presentEvent(previous: readonly LiveEvent[], event: WireEvent): readonly LiveEvent[] {
  if (event.type === 'retrying') return [...previous, { key: `retry:${previous.length}`, text: `Retry ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.error.message}` }];
  if (event.type === 'compacted') return [...previous, { key: `compact:${previous.length}`, text: `Compacted ${event.payload.replaced} items (summary ${event.payload.summaryId}).` }];
  if (event.type !== 'subagent') return previous;
  const child = event.payload.event;
  const prefix = `${event.payload.role} (${event.payload.agentId})`;
  const base = `subagent:${event.payload.agentId}:${child.turnId ?? ''}`;
  if (child.type === 'subagent') return presentEvent(previous, child);
  if (child.type === 'text_delta' || child.type === 'reasoning_delta') {
    const key = `${base}:${child.type}:${child.type === 'text_delta' ? child.payload.messageId : child.payload.messageId ?? ''}`;
    const index = previous.findIndex(line => line.key === key);
    const delta = child.payload.delta;
    if (index < 0) return [...previous, { key, text: `${prefix} ${child.type === 'text_delta' ? 'response' : 'reasoning'}: ${delta}` }];
    return previous.map((line, at) => at === index ? { ...line, text: line.text + delta } : line);
  }
  if (child.type === 'message' && child.payload.replacesDraftId) {
    const key = `${base}:text_delta:${child.payload.replacesDraftId}`;
    if (previous.some(line => line.key === key)) {
      return previous.map(line => line.key === key ? { ...line, text: `${prefix} response: ${child.payload.message.text}` } : line);
    }
  }
  let text: string | undefined;
  switch (child.type) {
    case 'tool_called': case 'tool_started': text = `${child.payload.tool.toolName} ${child.type === 'tool_called' ? 'called' : 'started'} (${child.payload.tool.executionId})`; break;
    case 'tool_progress': text = `tool ${child.payload.executionId}: ${child.payload.chunk}`; break;
    case 'tool_finished': text = `tool ${child.payload.executionId} ${child.payload.isError ? 'failed' : 'finished'}: ${child.payload.output}${(child.payload.content ?? []).filter(part => part.type === 'image').map(part => ` [image: ${part.mediaType}]`).join('')}`; break;
    case 'message': text = `${child.payload.message.role}: ${child.payload.message.text}`; break;
    case 'turn_ended': text = `${child.payload.outcome}${child.payload.error ? `: ${child.payload.error.message}` : ''}`; break;
    case 'error': text = `error: ${child.payload.error.message}`; break;
    case 'retrying': text = `retry ${child.payload.attempt} in ${child.payload.delayMs}ms: ${child.payload.error.message}`; break;
    case 'compacted': text = `compacted ${child.payload.replaced} items (summary ${child.payload.summaryId})`; break;
    default: break;
  }
  return text === undefined ? previous : [...previous, { key: `${base}:${child.type}:${previous.length}`, text: `${prefix} ${text}` }];
}
