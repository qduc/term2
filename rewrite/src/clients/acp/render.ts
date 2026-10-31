import type * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireContent, WireEvent, WireMessage, WireSnapshot, WireTool } from '../../protocol/direct-wire.js';

/** Fail explicitly when a required direct display contract has not landed. */
export class MissingAcpWireContract extends Error {
  constructor(detail: string) {
    super(`Direct ACP wire contract unavailable: ${detail}`);
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

function messageContents(message: WireMessage): acp.ContentBlock[] {
  return message.content.length ? message.content.map(contentBlock) : [{ type: 'text', text: message.text }];
}

function wholeMessage(message: WireMessage, id = message.id): acp.SessionUpdate | null {
  if (message.role === 'tool') return null;
  return {
    sessionUpdate: message.role === 'user' ? 'user_message' : 'agent_message',
    messageId: id,
    content: messageContents(message),
  };
}

/**
 * Encode the direct public wire as ACP, using occurrence ids for tools and the
 * explicit replacesDraftId relation for committed messages. No Session facts,
 * provider state or execution control are interpreted here.
 */
export class AcpRenderer {
  private readonly drafts = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly progress = new Map<string, string>();

  /** Replace bookkeeping from the host's current atomic snapshot, optionally replaying display. */
  snapshot(snapshot: WireSnapshot, replay: boolean): acp.SessionUpdate[] {
    this.drafts.clear();
    this.completed.clear();
    this.tools.clear();
    this.progress.clear();
    const updates: acp.SessionUpdate[] = [];
    for (const message of snapshot.messages) {
      if (message.draft) this.drafts.set(message.id, message.text);
      else this.completed.add(message.id);
      const update = wholeMessage(message);
      if (replay && update) updates.push(update);
    }
    for (const tool of snapshot.tools) {
      const update = this.tool(tool);
      if (replay) updates.push(update);
    }
    if (replay && snapshot.reasoning)
      updates.push({
        sessionUpdate: 'agent_thought',
        messageId: `${snapshot.activeTurnId ?? snapshot.sessionId}:thought`,
        content: [{ type: 'text', text: snapshot.reasoning }],
      });
    return updates;
  }

  /** Display-only telemetry with no ACP equivalent is intentionally omitted. */
  event(event: WireEvent): acp.SessionUpdate[] {
    switch (event.type) {
      case 'snapshot':
        return this.snapshot(event.payload.snapshot, true);
      case 'text_delta': {
        const { messageId, delta } = event.payload;
        if (this.completed.has(messageId)) return [];
        this.drafts.set(messageId, (this.drafts.get(messageId) ?? '') + delta);
        return [{ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: delta } }];
      }
      case 'reasoning_delta':
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: `${event.turnId ?? event.sessionId}:thought`,
            content: { type: 'text', text: event.payload.delta },
          },
        ];
      case 'message':
        return this.message(event.payload.message, event.payload.replacesDraftId);
      case 'tool_called':
      case 'tool_started':
        return [this.tool(event.payload.tool)];
      case 'tool_progress': {
        const text = (this.progress.get(event.payload.executionId) ?? '') + event.payload.chunk;
        this.progress.set(event.payload.executionId, text);
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.payload.executionId,
            status: 'in_progress',
            content: [{ type: 'content', content: { type: 'text', text } }],
          },
        ];
      }
      case 'tool_finished':
        this.progress.delete(event.payload.executionId);
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.payload.executionId,
            status: event.payload.isError ? 'failed' : 'completed',
            rawOutput: event.payload.output,
            content: [{ type: 'content', content: { type: 'text', text: event.payload.output } }],
          },
        ];
      default:
        return [];
    }
  }

  private message(message: WireMessage, replacesDraftId?: string): acp.SessionUpdate[] {
    if (this.completed.has(message.id)) return [];
    // ACP chunks append to a stable message. Keep the draft's ACP identity even
    // when the durable wire record has a different id, rather than duplicate it.
    const displayId = replacesDraftId ?? message.id;
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
        ? [
            {
              sessionUpdate: 'agent_message_chunk',
              messageId: displayId,
              content: { type: 'text', text: suffix },
            },
          ]
        : [];
    }
    // ACP v2's full-message update replaces content, supporting corrections and
    // media instead of appending a second copy of an already-streamed draft.
    const update = wholeMessage(message, displayId);
    return update ? [update] : [];
  }

  private tool(tool: WireTool): acp.SessionUpdate {
    if (tool.progress !== undefined) this.progress.set(tool.executionId, tool.progress);
    const output = tool.output ?? tool.progress;
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
      ...(tool.output === undefined ? {} : { rawOutput: tool.output }),
      ...(output === undefined
        ? {}
        : {
            content: [{ type: 'content', content: { type: 'text', text: output } }],
          }),
    };
  }
}

/** Map real terminal events, not command receipts, to ACP idle stop reasons. */
export function terminalOutcome(event: Extract<WireEvent, { type: 'turn_ended' }>): { stopReason: acp.StopReason } {
  if (event.payload.outcome === 'cancelled' || event.payload.outcome === 'interrupted')
    return { stopReason: 'cancelled' };
  if (event.payload.error?.kind === 'budget_exhausted') return { stopReason: 'max_turn_requests' };
  return { stopReason: event.payload.outcome === 'failed' ? '_term2_error' : 'end_turn' };
}
