/** Encode the direct public read model for the private HTTP client; never replay provider history. */
import type { WireSnapshot, WireTool } from '../protocol/direct-wire.js';
import type { Principal, ServerSessionPresentation, SessionMetadata } from './server-contracts.js';
import { ServerHttpError } from './server-errors.js';
import type { ServerInteractions } from './server-interactions.js';

const BODY_BUDGET = 2 * 1024 * 1024;
const TRUNCATED = '[truncated: session transcript size limit]';
type Command = {
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'unknown';
  output?: string;
  error?: string;
};
type Message = { id: string; role: 'user' | 'bot'; text: string; commands?: Command[] };
/** Dates/workspace/retention come from a read-only direct-store capability, not invented transport state.
 * Missing durable cursor fields fail explicitly instead of emitting a BFF-incompatible null/zero.
 */
export async function projectServerSession(
  snapshot: WireSnapshot,
  principal: Principal,
  presentation: ServerSessionPresentation,
  interactions: ServerInteractions,
): Promise<Record<string, unknown>> {
  const metadata = await presentation.metadata(principal, snapshot);
  if (snapshot.seq === null || metadata.earliestReplayableSequence === null)
    throw new ServerHttpError(
      503,
      'projection_unavailable',
      'gateway session projection requires direct Session durable and retention cursors',
      true,
    );
  const pending = snapshot.pendingInteractions[0];
  return {
    ...sessionListItem(snapshot, metadata),
    earliestReplayableSequence: metadata.earliestReplayableSequence,
    projectionSequence: snapshot.seq,
    transcript: { messages: transcriptMessages(snapshot), updatedAt: metadata.updatedAt },
    interaction: pending
      ? { state: 'pending', interaction: interactions.project(snapshot.sessionId, pending), turnId: pending.turnId }
      : null,
  };
}
export function sessionListItem(snapshot: WireSnapshot, metadata: SessionMetadata) {
  return {
    id: snapshot.sessionId,
    workspaceId: metadata.workspaceId,
    status: snapshot.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    latestSequence: snapshot.seq,
  };
}
function transcriptMessages(snapshot: WireSnapshot): Message[] {
  const result: Message[] = [];
  const commandTurns = new Set<string>();
  if (snapshot.tools.length && snapshot.timeline === null)
    throw new ServerHttpError(
      503,
      'projection_unavailable',
      'gateway tool transcript requires the authoritative direct Session timeline',
      true,
    );
  const byId = new Map(snapshot.messages.map((message) => [message.id, message]));
  const ordered =
    snapshot.timeline === null
      ? snapshot.messages
      : snapshot.timeline
          .filter((entry) => entry.kind === 'message')
          .map((entry) => {
            const message = byId.get(entry.id);
            if (!message)
              throw new ServerHttpError(
                503,
                'projection_unavailable',
                'direct transcript timeline is incomplete',
                true,
              );
            return message;
          });
  for (const message of ordered) {
    if (message.role === 'tool') continue;
    if (snapshot.tools.length && message.role === 'assistant' && !message.turnId)
      throw new ServerHttpError(
        503,
        'projection_unavailable',
        'gateway tool transcript requires accepted message-to-turn correlation',
        true,
      );
    const turnId = message.turnId;
    const commands =
      message.role === 'assistant' && turnId && !commandTurns.has(turnId)
        ? snapshot.tools
            .filter((tool) => tool.turnId === turnId && (tool.status === 'completed' || tool.status === 'unknown'))
            .map(commandCard)
        : [];
    if (commands.length && turnId) commandTurns.add(turnId);
    result.push({
      id: projectionText(message.id, 256),
      role: message.role === 'user' ? 'user' : 'bot',
      text: projectionText(message.text, 16_384),
      ...(commands.length ? { commands } : {}),
    });
  }
  const kept = result.slice(-200);
  let remaining = BODY_BUDGET;
  const fit = (value: string | undefined, max: number): string | undefined => {
    if (value === undefined) return undefined;
    if (value.length <= remaining) {
      remaining -= value.length;
      return value;
    }
    const take = Math.max(0, Math.min(remaining, max - TRUNCATED.length - 1));
    remaining = 0;
    return take ? `${value.slice(0, take)}\n${TRUNCATED}` : TRUNCATED;
  };
  for (const message of [...kept].reverse()) {
    for (const command of [...(message.commands ?? [])].reverse()) {
      command.error = fit(command.error, 10_000);
      command.output = fit(command.output, 16_384);
    }
  }
  return kept;
}
function commandCard(tool: WireTool): Command {
  const output = commandText(tool.output, 16_384);
  const error = tool.isError ? commandText(tool.output, 10_000) : undefined;
  return {
    callId: tool.executionId,
    toolName: projectionText(tool.toolName, 256),
    status: tool.status === 'unknown' ? 'unknown' : tool.isError ? 'failed' : 'completed',
    ...(output && output !== error ? { output } : {}),
    ...(error ? { error } : {}),
  };
}
function projectionText(text: string, max: number): string {
  return text.slice(0, max).replace(/[\u0000\u007f]/gu, '\uFFFD');
}
function commandText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const bounded = projectionText(text, max);
  return /^Bearer\s+|^sk-[A-Za-z0-9]/u.test(bounded) ? '[output withheld: looks like a credential]' : bounded;
}
