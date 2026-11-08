import type * as v1 from '@agentclientprotocol/sdk';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2';

/**
 * Convert the renderer's upserts to v1 append-only chunks. Remember displayed
 * content per session/message so snapshots and final messages do not duplicate
 * streamed output. A rewritten prefix cannot be represented and fails explicitly.
 */
export class V1Output {
  private readonly messages = new Map<string, v1.ContentBlock[]>();
  private readonly tools = new Set<string>();
  private readonly submitted = new Set<string>();

  /** V1 clients already display their own input; fresh load attachments still replay it. */
  promptAccepted(sessionId: string, messageId: string): void {
    this.submitted.add(JSON.stringify([sessionId, messageId]));
  }

  translate(sessionId: string, update: v2.SessionUpdate): v1.SessionUpdate[] {
    if (
      (update.sessionUpdate === 'user_message' || update.sessionUpdate === 'user_message_chunk') &&
      this.submitted.has(JSON.stringify([sessionId, (update as v2.ContentChunk).messageId]))
    )
      return [];
    switch (update.sessionUpdate) {
      case 'state_update':
        return []; // v1 completion belongs to the pending prompt response.
      case 'user_message':
      case 'agent_message':
      case 'agent_thought': {
        const message = update as v2.AgentMessage;
        if (!message.content) return [];
        const kind =
          update.sessionUpdate === 'user_message'
            ? 'user_message_chunk'
            : update.sessionUpdate === 'agent_thought'
            ? 'agent_thought_chunk'
            : 'agent_message_chunk';
        const key = JSON.stringify([sessionId, kind, message.messageId]);
        const previous = this.messages.get(key) ?? [];
        const content = normalize(message.content.map(v1Content));
        const suffix = remaining(previous, content);
        this.messages.set(key, content);
        return suffix.map((block) => ({ sessionUpdate: kind, messageId: message.messageId, content: block }));
      }
      case 'agent_message_chunk':
      case 'user_message_chunk':
      case 'agent_thought_chunk': {
        const chunk = update as v2.ContentChunk;
        const key = JSON.stringify([sessionId, update.sessionUpdate, chunk.messageId]);
        this.messages.set(key, normalize([...(this.messages.get(key) ?? []), v1Content(chunk.content)]));
        return [{ sessionUpdate: update.sessionUpdate, messageId: chunk.messageId, content: v1Content(chunk.content) }];
      }
      case 'tool_call':
      case 'tool_call_update': {
        const tool = v1Tool(update as v2.ToolCallUpdate);
        const key = JSON.stringify([sessionId, tool.toolCallId]);
        const seen = this.tools.has(key);
        this.tools.add(key);
        return [
          seen
            ? { ...tool, sessionUpdate: 'tool_call_update' }
            : {
                ...tool,
                sessionUpdate: 'tool_call',
                title: tool.title ?? 'Tool',
                kind: tool.kind ?? undefined,
                status: tool.status ?? undefined,
                content: tool.content ?? undefined,
                locations: tool.locations ?? undefined,
                name: tool.name ?? undefined,
              },
        ];
      }
      default:
        throw new Error(`ACP v1 cannot represent renderer update: ${update.sessionUpdate}`);
    }
  }
}

function normalize(content: readonly v1.ContentBlock[]): v1.ContentBlock[] {
  const result: v1.ContentBlock[] = [];
  for (const block of content) {
    const last = result.at(-1);
    if (last?.type === 'text' && block.type === 'text')
      result[result.length - 1] = { ...last, text: last.text + block.text };
    else result.push(block);
  }
  return result;
}

function remaining(previous: readonly v1.ContentBlock[], next: readonly v1.ContentBlock[]): v1.ContentBlock[] {
  const suffix: v1.ContentBlock[] = [];
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!;
    const after = next[index];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (
      index === previous.length - 1 &&
      before.type === 'text' &&
      after?.type === 'text' &&
      after.text.startsWith(before.text)
    ) {
      const text = after.text.slice(before.text.length);
      if (text) suffix.push({ ...after, text });
    } else throw new Error('ACP v1 cannot replace content already displayed');
  }
  return [...suffix, ...next.slice(previous.length)];
}

/** The shared renderer produces text/image content; unknown v2 extensions are never sent to v1. */
function v1Content(block: v2.ContentBlock): v1.ContentBlock {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
    return { type: 'image', data: block.data, mimeType: block.mimeType };
  throw new Error(`Unsupported ACP v1 renderer content: ${block.type}`);
}

/** Map the renderer's shared tool fields, excluding v2-only content variants. */
export function v1Tool(tool: v2.ToolCallUpdate): v1.ToolCallUpdate {
  return {
    toolCallId: tool.toolCallId,
    title: tool.title,
    name: tool.name,
    rawInput: tool.rawInput,
    rawOutput: tool.rawOutput,
    locations: tool.locations,
    // The shared renderer owns these finite values; v2's extensible SDK widens them to string.
    kind: tool.kind as v1.ToolKind | undefined,
    status: tool.status as v1.ToolCallStatus | undefined,
    content: tool.content?.map((part) => {
      if (part.type !== 'content') throw new Error(`Unsupported ACP v1 tool content: ${part.type}`);
      return { type: 'content', content: v1Content((part as v2.Content).content) };
    }),
  };
}
