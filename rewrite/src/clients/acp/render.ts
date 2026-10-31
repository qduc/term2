import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type {
  WireContent,
  WireEvent,
  WireMessage,
  WireSnapshot,
  WireTool,
  WireToolResult,
} from '../../protocol/direct-wire.js';

/** Surface a missing direct contract as an explicit ACP error, not fake success. */
export class MissingAcpWireContract extends acp.RequestError {
  constructor(detail: string) {
    super(-32000, `Direct ACP wire contract unavailable: ${detail}`);
    this.name = 'MissingAcpWireContract';
  }
}

function toolKind(name: string): acp.ToolKind {
  if (/read|search|list|glob/i.test(name)) return 'read';
  if (/edit|write|patch/i.test(name)) return 'edit';
  if (/shell|command|exec/i.test(name)) return 'execute';
  if (/web|fetch/i.test(name)) return 'fetch';
  return 'other';
}

function contentBlock(content: WireContent): acp.ContentBlock {
  return content.type === 'text'
    ? { type: 'text', text: content.text }
    : { type: 'image', data: content.data, mimeType: content.mediaType };
}

function wholeMessage(message: WireMessage, id = message.id): acp.SessionUpdate | null {
  if (message.role === 'tool') return null;
  return {
    sessionUpdate: message.role === 'user' ? 'user_message' : 'agent_message',
    messageId: id,
    content: message.content.length ? message.content.map(contentBlock) : [{ type: 'text', text: message.text }],
  };
}

function toolOutput(output: string | undefined, content: readonly WireContent[] | undefined): acp.ToolCallContent[] {
  const parts = content ?? (output === undefined ? [] : [{ type: 'text' as const, text: output }]);
  return parts.map((part) => ({ type: 'content', content: contentBlock(part) }));
}

function thoughtId(snapshot: WireSnapshot): string {
  return snapshot.reasoningIdentity?.messageId ?? `${snapshot.activeTurnId ?? snapshot.sessionId}:thought`;
}

type Entry =
  | { readonly kind: 'message'; readonly message: WireMessage }
  | { readonly kind: 'tool'; readonly tool: WireTool }
  | { readonly kind: 'result'; readonly result: WireToolResult };
const messageKey = (id: string): string => `message:${id}`;
const toolKey = (id: string): string => `tool:${id}`;

function entries(snapshot: WireSnapshot): readonly Entry[] {
  const messages = new Map(
    snapshot.messages.filter((message) => message.role !== 'tool').map((message) => [message.id, message]),
  );
  const tools = new Map(snapshot.tools.map((tool) => [tool.executionId, tool]));
  const results = new Map(
    (snapshot.unmatchedToolResults ?? [])
      .filter((result) => !tools.has(result.executionId))
      .map((result) => [result.executionId, result]),
  );
  if (!snapshot.timeline) {
    if (results.size) throw new MissingAcpWireContract('snapshot.timeline needed for unmatched tool result order');
    if (messages.size && tools.size)
      throw new MissingAcpWireContract('snapshot.timeline needed for ordered mixed transcript replay');
    return [...messages.values()]
      .map((message): Entry => ({ kind: 'message', message }))
      .concat([...tools.values()].map((tool): Entry => ({ kind: 'tool', tool })));
  }
  const result = snapshot.timeline.map((item): Entry => {
    const message = item.kind === 'message' ? messages.get(item.id) : undefined;
    const tool = item.kind === 'tool' ? tools.get(item.id) : undefined;
    if (message) {
      messages.delete(item.id);
      return { kind: 'message', message };
    }
    if (tool) {
      tools.delete(item.id);
      return { kind: 'tool', tool };
    }
    const result = item.kind === 'tool' ? results.get(item.id) : undefined;
    if (result) {
      results.delete(item.id);
      return { kind: 'result', result };
    }
    throw new MissingAcpWireContract('snapshot.timeline references absent/duplicate display item');
  });
  if (messages.size || tools.size || results.size)
    throw new MissingAcpWireContract('snapshot.timeline omits display items');
  return result;
}

/** Encode public wire data only. IDs, sequence, decisions and execution remain Session-owned. */
export class AcpRenderer {
  private readonly drafts = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly progress = new Map<string, string>();
  private readonly known = new Map<string, boolean>();
  private readonly aliases = new Map<string, string>();
  private readonly hiddenThoughts = new Set<string>();

  /** Seed an atomic fresh attachment. Replay must use authoritative mixed ordering. */
  snapshot(snapshot: WireSnapshot, replay: boolean): acp.SessionUpdate[] {
    const ordered = replay ? entries(snapshot) : [];
    this.seed(snapshot);
    this.hiddenThoughts.clear();
    if (!replay && snapshot.reasoning) this.hiddenThoughts.add(thoughtId(snapshot));
    const updates: acp.SessionUpdate[] = [];
    for (const entry of ordered) this.upsert(entry, updates);
    if (replay) updates.push(...this.reasoning(snapshot));
    return updates;
  }

  /** Telemetry without an ACP display equivalent is intentionally omitted. */
  event(event: WireEvent): acp.SessionUpdate[] {
    switch (event.type) {
      case 'snapshot':
        return this.refresh(event.payload.snapshot);
      case 'turn_started':
        return event.payload.input.flatMap((message) => this.message(message));
      case 'text_delta': {
        const { messageId, delta } = event.payload;
        if (this.completed.has(messageId)) return [];
        this.known.set(messageKey(messageId), true);
        this.drafts.set(messageId, (this.drafts.get(messageId) ?? '') + delta);
        return [{ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: delta } }];
      }
      case 'reasoning':
        this.hiddenThoughts.delete(event.payload.messageId);
        return [
          {
            sessionUpdate: 'agent_thought',
            messageId: event.payload.messageId,
            content: [{ type: 'text', text: event.payload.text }],
          },
        ];
      case 'reasoning_delta':
        this.hiddenThoughts.delete(event.payload.messageId ?? `${event.turnId ?? event.sessionId}:thought`);
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: event.payload.messageId ?? `${event.turnId ?? event.sessionId}:thought`,
            content: { type: 'text', text: event.payload.delta },
          },
        ];
      case 'message':
        return this.message(event.payload.message, event.payload.replacesDraftId);
      case 'queue_changed':
        return (event.payload.messages ?? []).flatMap((message) => this.message(message));
      case 'tool_called':
      case 'tool_started':
        this.known.set(toolKey(event.payload.tool.executionId), true);
        return [this.tool(event.payload.tool)];
      case 'tool_progress': {
        this.tools.add(event.payload.executionId);
        const text = (this.progress.get(event.payload.executionId) ?? '') + event.payload.chunk;
        this.progress.set(event.payload.executionId, text);
        this.known.set(toolKey(event.payload.executionId), true);
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.payload.executionId,
            status: 'in_progress',
            content: toolOutput(text, undefined),
          },
        ];
      }
      case 'tool_finished':
        return [this.finished(event.payload)];
      default:
        return [];
    }
  }

  private seed(snapshot: WireSnapshot): void {
    this.drafts.clear();
    this.completed.clear();
    this.tools.clear();
    this.progress.clear();
    this.known.clear();
    this.aliases.clear();
    for (const message of snapshot.messages) {
      if (message.replacesDraftId) this.aliases.set(message.id, message.replacesDraftId);
      if (message.draft) this.drafts.set(message.id, message.text);
      else {
        this.completed.add(message.id);
        const alias = this.aliases.get(message.id);
        if (alias) this.completed.add(alias);
      }
      this.known.set(messageKey(message.id), false);
      if (message.replacesDraftId) this.known.set(messageKey(message.replacesDraftId), false);
    }
    for (const result of snapshot.unmatchedToolResults ?? []) this.known.set(toolKey(result.executionId), false);
    for (const tool of snapshot.tools) {
      this.known.set(toolKey(tool.executionId), false);
      if (tool.progress !== undefined) this.progress.set(tool.executionId, tool.progress);
    }
  }

  private upsert(entry: Entry, updates: acp.SessionUpdate[]): void {
    if (entry.kind === 'tool') {
      this.known.set(toolKey(entry.tool.executionId), true);
      updates.push(this.tool(entry.tool));
    } else if (entry.kind === 'result') {
      this.known.set(toolKey(entry.result.executionId), true);
      updates.push(this.finished(entry.result));
    } else {
      this.known.set(messageKey(entry.message.id), true);
      if (entry.message.replacesDraftId) this.known.set(messageKey(entry.message.replacesDraftId), true);
      const update = wholeMessage(entry.message, this.aliases.get(entry.message.id));
      if (update) updates.push(update);
    }
  }

  private refresh(snapshot: WireSnapshot): acp.SessionUpdate[] {
    const previous = new Map(this.known);
    const previousTools = new Set(this.tools);
    const all: Entry[] = [
      ...snapshot.messages
        .filter((message) => message.role !== 'tool')
        .map((message): Entry => ({ kind: 'message', message })),
      ...snapshot.tools.map((tool): Entry => ({ kind: 'tool', tool })),
      ...(snapshot.unmatchedToolResults ?? [])
        .filter((result) => !snapshot.tools.some((tool) => tool.executionId === result.executionId))
        .map((result): Entry => ({ kind: 'result', result })),
    ];
    const key = (entry: Entry): string =>
      entry.kind === 'message'
        ? messageKey(entry.message.id)
        : toolKey(entry.kind === 'tool' ? entry.tool.executionId : entry.result.executionId);
    const hasNew = all.some((entry) => !previous.has(key(entry)));
    // Upserting already displayed IDs does not change their observed order.
    // New mixed items require the authoritative timeline; array concatenation
    // is not a claim that messages happened before tools.
    const ordered = snapshot.timeline || hasNew ? entries(snapshot) : all;
    this.seed(snapshot);
    for (const id of previousTools) this.tools.add(id);
    const updates: acp.SessionUpdate[] = [];
    for (const entry of ordered) {
      const wasVisible =
        previous.get(key(entry)) ??
        (entry.kind === 'message' && entry.message.replacesDraftId
          ? previous.get(messageKey(entry.message.replacesDraftId))
          : undefined);
      if (wasVisible === false) continue; // A resume without replay keeps old history hidden.
      this.upsert(entry, updates);
    }
    updates.push(...this.reasoning(snapshot));
    return updates;
  }

  private reasoning(snapshot: WireSnapshot): acp.SessionUpdate[] {
    return snapshot.reasoning && !this.hiddenThoughts.has(thoughtId(snapshot))
      ? [
          {
            sessionUpdate: 'agent_thought',
            messageId: thoughtId(snapshot),
            content: [{ type: 'text', text: snapshot.reasoning }],
          },
        ]
      : [];
  }

  private message(message: WireMessage, replacesDraftId?: string): acp.SessionUpdate[] {
    if (this.completed.has(message.id)) return [];
    const displayId = replacesDraftId ?? message.replacesDraftId ?? message.id;
    this.aliases.set(message.id, displayId);
    this.known.set(messageKey(message.id), true);
    this.known.set(messageKey(displayId), true);
    const draft = this.drafts.get(displayId);
    this.drafts.delete(displayId);
    this.completed.add(message.id);
    this.completed.add(displayId);
    if (
      draft !== undefined &&
      message.content.every((part) => part.type === 'text') &&
      message.text.startsWith(draft)
    ) {
      const suffix = message.text.slice(draft.length);
      return suffix
        ? [{ sessionUpdate: 'agent_message_chunk', messageId: displayId, content: { type: 'text', text: suffix } }]
        : [];
    }
    const update = wholeMessage(message, displayId);
    return update ? [update] : [];
  }

  /** Results use actual accepted metadata when available; absent names stay absent. */
  private finished(result: WireToolResult): acp.SessionUpdate {
    const { executionId, output, content, display, isError, toolName, input } = result;
    this.progress.delete(executionId);
    this.tools.add(executionId);
    this.known.set(toolKey(executionId), true);
    const fields = {
      toolCallId: executionId,
      status: isError ? ('failed' as const) : ('completed' as const),
      rawOutput: display === undefined ? output : { text: output, display },
      content: toolOutput(output, content),
    };
    return toolName === undefined
      ? { sessionUpdate: 'tool_call_update', ...fields }
      : {
          sessionUpdate: 'tool_call',
          ...fields,
          title: toolName,
          name: toolName,
          kind: toolKind(toolName),
          ...(input !== undefined ? { rawInput: input } : {}),
        };
  }

  private tool(tool: WireTool): acp.SessionUpdate {
    if (tool.progress !== undefined) this.progress.set(tool.executionId, tool.progress);
    const exists = this.tools.has(tool.executionId);
    this.tools.add(tool.executionId);
    const status =
      tool.status === 'called'
        ? 'pending'
        : tool.status === 'started'
        ? 'in_progress'
        : tool.status === 'completed' && !tool.isError
        ? 'completed'
        : 'failed';
    return {
      sessionUpdate: exists ? 'tool_call_update' : 'tool_call',
      toolCallId: tool.executionId,
      title: tool.toolName,
      name: tool.toolName,
      kind: toolKind(tool.toolName),
      status,
      rawInput: tool.input,
      ...(tool.output === undefined && tool.display === undefined
        ? {}
        : {
            rawOutput: tool.display === undefined ? tool.output : { text: tool.output ?? '', display: tool.display },
          }),
      content: toolOutput(tool.output ?? tool.progress, tool.content),
    };
  }
}

/** Snapshot terminals and live terminals share exact outcomes; receipts are not terminals. */
export function terminalOutcome(
  terminal: NonNullable<WireSnapshot['terminal']> | Extract<WireEvent, { type: 'turn_ended' }>['payload'],
): { stopReason: acp.StopReason } {
  if (terminal.outcome === 'cancelled' || terminal.outcome === 'interrupted') return { stopReason: 'cancelled' };
  return { stopReason: terminal.outcome === 'failed' ? '_term2_error' : 'end_turn' };
}
