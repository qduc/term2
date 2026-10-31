import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireContent, WireEvent, WireMessage, WireSnapshot, WireTool } from '../../protocol/direct-wire.js';

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

type Entry =
  | { readonly kind: 'message'; readonly message: WireMessage }
  | { readonly kind: 'tool'; readonly tool: WireTool };
const messageKey = (id: string): string => `message:${id}`;
const toolKey = (id: string): string => `tool:${id}`;

function entries(snapshot: WireSnapshot): readonly Entry[] {
  const messages = new Map(
    snapshot.messages.filter((message) => message.role !== 'tool').map((message) => [message.id, message]),
  );
  const tools = new Map(snapshot.tools.map((tool) => [tool.executionId, tool]));
  if (!snapshot.timeline) {
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
    throw new MissingAcpWireContract('snapshot.timeline references absent/duplicate display item');
  });
  if (messages.size || tools.size) throw new MissingAcpWireContract('snapshot.timeline omits display items');
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

  /** Seed an atomic fresh attachment. Replay must use authoritative mixed ordering. */
  snapshot(snapshot: WireSnapshot, replay: boolean): acp.SessionUpdate[] {
    const ordered = replay ? entries(snapshot) : [];
    this.seed(snapshot);
    const updates: acp.SessionUpdate[] = [];
    for (const entry of ordered) this.upsert(entry, updates);
    if (replay && snapshot.reasoning)
      updates.push({
        sessionUpdate: 'agent_thought',
        messageId: `${snapshot.activeTurnId ?? snapshot.sessionId}:thought`,
        content: [{ type: 'text', text: snapshot.reasoning }],
      });
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
      case 'reasoning_delta':
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: event.payload.messageId ?? `${event.turnId ?? event.sessionId}:thought`,
            content: { type: 'text', text: event.payload.delta },
          },
        ];
      case 'message':
        return this.message(event.payload.message, event.payload.replacesDraftId);
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
      case 'tool_finished': {
        const { executionId, output, content, display, isError } = event.payload;
        this.progress.delete(executionId);
        this.tools.add(executionId);
        this.known.set(toolKey(executionId), true);
        // Invalid/no-body calls can finish without any start. ACP upserts them
        // by execution id; no provider call-id alias or duplicate message.
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: executionId,
            status: isError ? 'failed' : 'completed',
            rawOutput: display === undefined ? output : { text: output, display },
            content: toolOutput(output, content),
          },
        ];
      }
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
    for (const message of snapshot.messages) {
      if (message.draft) this.drafts.set(message.id, message.text);
      else {
        this.completed.add(message.id);
        const alias = this.aliases.get(message.id);
        if (alias) this.completed.add(alias);
      }
      this.known.set(messageKey(message.id), false);
    }
    for (const tool of snapshot.tools) {
      this.known.set(toolKey(tool.executionId), false);
      if (tool.progress !== undefined) this.progress.set(tool.executionId, tool.progress);
    }
  }

  private upsert(entry: Entry, updates: acp.SessionUpdate[]): void {
    if (entry.kind === 'tool') {
      this.known.set(toolKey(entry.tool.executionId), true);
      updates.push(this.tool(entry.tool));
    } else {
      this.known.set(messageKey(entry.message.id), true);
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
    ];
    const key = (entry: Entry): string =>
      entry.kind === 'message' ? messageKey(entry.message.id) : toolKey(entry.tool.executionId);
    const hasNew = all.some((entry) => !previous.has(key(entry)));
    // Upserting already displayed IDs does not change their observed order.
    // New mixed items require the authoritative timeline; array concatenation
    // is not a claim that messages happened before tools.
    const ordered = snapshot.timeline || hasNew ? entries(snapshot) : all;
    this.seed(snapshot);
    for (const id of previousTools) this.tools.add(id);
    const updates: acp.SessionUpdate[] = [];
    for (const entry of ordered) {
      const wasVisible = previous.get(key(entry));
      if (wasVisible === false) continue; // A resume without replay keeps old history hidden.
      this.upsert(entry, updates);
    }
    return updates;
  }

  private message(message: WireMessage, replacesDraftId?: string): acp.SessionUpdate[] {
    if (this.completed.has(message.id)) return [];
    const displayId = replacesDraftId ?? message.id;
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
