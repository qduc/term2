/** Encode the direct public read model for the private HTTP client; never replay provider history. */
import type { WireSnapshot, WireTool } from '../protocol/wire.js';
import type { Principal, ServerSessionPresentation, SessionMetadata } from './server-contracts.js';
import { ServerHttpError } from './server-errors.js';
import type { ServerInteractions } from './server-interactions.js';

const BODY_BUDGET = 2 * 1024 * 1024;
const TRUNCATED = '[truncated: session transcript size limit]';
type Command = {
  callId: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
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
  const budget = snapshot.pendingBudgets?.[0];
  return {
    ...sessionListItem(snapshot, metadata),
    earliestReplayableSequence: metadata.earliestReplayableSequence,
    projectionSequence: snapshot.seq,
    transcript: { messages: transcriptMessages(snapshot), updatedAt: metadata.updatedAt },
    interaction: pending
      ? { state: 'pending', interaction: interactions.project(snapshot.sessionId, pending), turnId: pending.turnId }
      : budget
      ? { state: 'pending', interaction: interactions.projectBudget(budget), turnId: budget.turnId }
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
  const toolsById = new Map(snapshot.tools.map((tool) => [tool.executionId, tool]));
  const commandsByTurn = new Map<string, Command[]>();
  // Tool order comes from the accepted mixed timeline, not the runtime's separate tool array.
  for (const entry of snapshot.timeline ?? []) {
    if (entry.kind !== 'tool') continue;
    const tool = toolsById.get(entry.id);
    if (!tool) return incompleteTimeline();
    const commands = commandsByTurn.get(tool.turnId) ?? [];
    commands.push(commandCard(tool));
    commandsByTurn.set(tool.turnId, commands);
  }
  const replyTurns = new Set(
    snapshot.messages.flatMap((message) => (message.role === 'assistant' && message.turnId ? [message.turnId] : [])),
  );
  const ordered =
    snapshot.timeline ?? snapshot.messages.map((message) => ({ kind: 'message' as const, id: message.id }));
  for (const entry of ordered) {
    if (entry.kind === 'tool') {
      const tool = toolsById.get(entry.id);
      if (!tool) return incompleteTimeline();
      if (replyTurns.has(tool.turnId) || commandTurns.has(tool.turnId)) continue;
      // A tool-only or stopped-before-text turn still has cards. This is a deterministic
      // presentation row at the accepted tool boundary, not an invented assistant message/fact.
      result.push({
        id: projectionText(`tools-${tool.turnId}`, 256),
        role: 'bot',
        text: '',
        commands: commandsByTurn.get(tool.turnId)?.slice(0, 64),
      });
      commandTurns.add(tool.turnId);
      continue;
    }
    const message = byId.get(entry.id);
    if (!message) return incompleteTimeline();
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
        ? (commandsByTurn.get(turnId) ?? []).slice(0, 64)
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
    status:
      tool.status === 'called' || tool.status === 'started'
        ? 'running'
        : tool.status === 'unknown'
        ? 'unknown'
        : tool.isError
        ? 'failed'
        : 'completed',
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

function incompleteTimeline(): never {
  throw new ServerHttpError(503, 'projection_unavailable', 'direct transcript timeline is incomplete', true);
}
