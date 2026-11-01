import { nativeStateFromSnapshot } from './native-state';
import { emptyTerm2SessionView } from './event-adapter';
import { parsePendingInteraction, Term2ProtocolError, type InteractionProjection, type Term2SessionView, type Term2TurnView } from './types';

/** Browser-owned projection of fields it renders, not a copied protocol/runtime.
 * The full public snapshot is retained verbatim, including optional evidence. */
export interface NativeBranchHydration extends Readonly<Record<string, unknown>> {
  branchId: string; taskId: string; turnId: string; parentTurnId?: string; rootTurnId?: string;
  acceptedSeq: number;
  messages: readonly Record<string, unknown>[];
  tools: readonly Record<string, unknown>[];
  timeline: readonly { kind: 'message' | 'tool'; id: string }[] | null;
  reasoning: string | null;
  queue: null;
}

export interface SessionHydration {
  schemaVersion: 2;
  kind: 'snapshot';
  sessionId: string;
  seq: number;
  earliestReplayableSequence: number | null;
  interaction: InteractionProjection;
  snapshot: Readonly<Record<string, unknown>> & {
    sessionId: string; backingSessionId: string; seq: number; status: string;
    activeTurnId: string | null;
    branches?: readonly NativeBranchHydration[];
    messages: readonly Record<string, unknown>[];
    tools: readonly Record<string, unknown>[];
    timeline: readonly { kind: 'message' | 'tool'; id: string }[] | null;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Term2ProtocolError('Invalid native hydration object');
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Term2ProtocolError('Invalid native hydration identity');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Term2ProtocolError('Invalid native hydration text');
  return value;
}
function ordinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Term2ProtocolError('Invalid accepted hydration cursor');
  return value;
}
function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Term2ProtocolError('Invalid native hydration array');
  return value.map(record);
}

function parseContext(context: Readonly<Record<string, unknown>>) {
  const messages = records(context.messages);
  const tools = records(context.tools);
  for (const message of messages) {
    identity(message.id); text(message.text);
    if (!['user', 'assistant', 'tool'].includes(String(message.role))) throw new Term2ProtocolError('Invalid native message role');
    if (message.turnId !== undefined) identity(message.turnId);
  }
  for (const tool of tools) {
    identity(tool.executionId); identity(tool.turnId); text(tool.toolName);
    if (!['called', 'started', 'completed', 'unknown'].includes(String(tool.status))) throw new Term2ProtocolError('Invalid native tool status');
  }
  let timeline: SessionHydration['snapshot']['timeline'] = null;
  if (context.timeline !== null) {
    timeline = records(context.timeline).map(entry => {
      if (entry.kind !== 'message' && entry.kind !== 'tool') throw new Term2ProtocolError('Invalid native timeline');
      return { kind: entry.kind, id: identity(entry.id) };
    });
    for (const entry of timeline) {
      if (!(entry.kind === 'message' ? messages.some(item => item.id === entry.id) : tools.some(item => item.executionId === entry.id)))
        throw new Term2ProtocolError('Native timeline references missing evidence');
    }
  }
  return { messages, tools, timeline };
}

/** Parse the separately negotiated current accepted cut; never turn it into an SSE event. */
export function parseSessionHydration(value: unknown, sessionId: string): SessionHydration {
  const root = record(value);
  if (root.schemaVersion !== 2 || root.kind !== 'snapshot' || root.sessionId !== sessionId) throw new Term2ProtocolError('Hydration identity/version mismatch');
  const seq = ordinal(root.seq);
  const snapshot = record(root.snapshot);
  if (snapshot.sessionId !== sessionId || snapshot.seq !== seq) throw new Term2ProtocolError('Hydration snapshot cursor mismatch');
  identity(snapshot.backingSessionId);
  if (!['idle', 'running', 'awaiting_interaction', 'interrupted', 'closed'].includes(String(snapshot.status))) throw new Term2ProtocolError('Invalid native status');
  if (snapshot.activeTurnId !== null) identity(snapshot.activeTurnId);
  const { messages, tools, timeline } = parseContext(snapshot);
  if (snapshot.protocolVersion !== 1) throw new Term2ProtocolError('Unsupported public snapshot protocol');
  let branches: NativeBranchHydration[] | undefined;
  if (snapshot.branches !== undefined) {
    branches = records(snapshot.branches).map(branch => {
      identity(branch.branchId); identity(branch.taskId); identity(branch.turnId);
      if (branch.parentTurnId !== undefined) identity(branch.parentTurnId);
      if (branch.rootTurnId !== undefined) identity(branch.rootTurnId);
      const acceptedSeq = ordinal(branch.acceptedSeq);
      if (acceptedSeq > seq || branch.queue !== null) throw new Term2ProtocolError('Invalid accepted branch cut/capability');
      if (branch.usage !== null) record(branch.usage);
      if (branch.reasoning !== null) text(branch.reasoning);
      for (const key of ['unmatchedToolResults', 'pendingInteractions', 'pendingBudgets', 'turnResults', 'notices', 'requestCosts']) records(branch[key]);
      return { ...branch, ...parseContext(branch), branchId: branch.branchId as string, taskId: branch.taskId as string, turnId: branch.turnId as string,
        ...(branch.parentTurnId === undefined ? {} : { parentTurnId: branch.parentTurnId as string }),
        ...(branch.rootTurnId === undefined ? {} : { rootTurnId: branch.rootTurnId as string }),
        acceptedSeq, reasoning: branch.reasoning as string | null, queue: null };
    });
  }
  for (const key of ['queue', 'tasks', 'notices', 'pendingInteractions', 'admissions']) records(snapshot[key]);
  record(snapshot.usage); record(snapshot.configuration); text(snapshot.reasoning);
  const earliest = root.earliestReplayableSequence === null ? null : ordinal(root.earliestReplayableSequence);
  if (earliest !== null && earliest > seq) throw new Term2ProtocolError('Incoherent native replay cut');
  let interaction: InteractionProjection = null;
  if (root.interaction !== null) {
    const pending = record(root.interaction);
    if (pending.state !== 'pending') throw new Term2ProtocolError('Invalid same-cut interaction');
    interaction = { state: 'pending', turnId: identity(pending.turnId), interaction: parsePendingInteraction(pending.interaction) };
    if (pending.subagent !== undefined) {
      const owner = record(pending.subagent);
      interaction.subagent = { agentId: identity(owner.agentId), role: text(owner.role) };
    }
  }
  return { schemaVersion: 2, kind: 'snapshot', sessionId, seq, earliestReplayableSequence: earliest, interaction,
    snapshot: { ...snapshot, sessionId, backingSessionId: snapshot.backingSessionId as string, seq, status: snapshot.status as string,
      activeTurnId: snapshot.activeTurnId as string | null, messages, tools, timeline, ...(branches === undefined ? {} : { branches }) } };
}

/** Render actual root messages/tools using native turn and timeline ownership only.
 * Unknown turn ownership stays in the snapshot disclosure, never guessed from adjacency. */
export function viewFromHydration(hydration: SessionHydration): Term2SessionView {
  const view = emptyTerm2SessionView(hydration.sessionId);
  view.hydration = hydration;
  view.nativeState = nativeStateFromSnapshot(hydration.snapshot);
  view.lastAppliedSequence = hydration.seq;
  view.pendingInteraction = hydration.interaction;
  const snapshot = hydration.snapshot;
  view.rootEvidence = Object.fromEntries(['queue', 'queueState', 'queuePauseReason', 'tasks', 'usage', 'cost', 'requestCosts', 'goal', 'goalProposal', 'goalGeneration', 'verification', 'notices', 'notifications', 'commands', 'admissions', 'submissions'].filter(key => key in snapshot).map(key => [key, snapshot[key]]));
  view.status = snapshot.status === 'idle' ? 'connected' : snapshot.status as Term2SessionView['status'];
  view.turns = contextTurns(snapshot, snapshot.activeTurnId, snapshot.status);
  if (snapshot.branches !== undefined) {
    view.branches = Object.fromEntries(snapshot.branches.map(branch => {
      const branchView = emptyTerm2SessionView(hydration.sessionId);
      branchView.nativeBranch = branch;
      branchView.nativeState = nativeStateFromSnapshot(branch);
      branchView.turns = contextTurns(branch, null, null);
      const { branchId, taskId, turnId, parentTurnId, rootTurnId } = branch;
      const identity = { branchId, taskId, turnId, ...(parentTurnId === undefined ? {} : { parentTurnId }), ...(rootTurnId === undefined ? {} : { rootTurnId }) };
      return [branch.branchId, { identity, view: branchView }];
    }));
  }

  return view;
}

/** A branch acceptedSeq is observation provenance, never a second reconnect cursor. */
function contextTurns(context: Pick<SessionHydration['snapshot'], 'messages' | 'tools' | 'timeline'> & Readonly<Record<string, unknown>>, activeTurnId: string | null, status: string | null): Term2TurnView[] {
  const turns: Term2TurnView[] = [];
  const getTurn = (turnId: string): Term2TurnView => {
    let item = turns.find(item => item.turnId === turnId);
    if (!item) { item = { turnId, role: 'assistant', text: '', reasoning: '', status: 'unknown', commands: [] }; turns.push(item); }
    return item;
  };
  const message = (entry: Record<string, unknown>) => {
    if (typeof entry.turnId !== 'string' || entry.role === 'tool') return;
    const item = getTurn(entry.turnId);
    if (entry.role === 'user') item.userText = (item.userText ?? '') + text(entry.text);
    else item.text += text(entry.text);
  };
  const tool = (entry: Record<string, unknown>) => {
    const item = getTurn(identity(entry.turnId));
    item.commands.push({ callId: identity(entry.executionId), toolName: text(entry.toolName),
      status: entry.status === 'started' ? 'running' : entry.status === 'called' ? 'pending' : entry.status === 'completed' ? entry.isError === true ? 'failed' : 'completed' : 'unknown',
      ...(typeof entry.output === 'string' ? { output: entry.output } : {}),
    });
  };
  if (context.timeline) {
    for (const entry of context.timeline) {
      if (entry.kind === 'message') message(context.messages.find(item => item.id === entry.id)!);
      else tool(context.tools.find(item => item.executionId === entry.id)!);
    }
  } else if (context.tools.length === 0) {
    // The message array itself supplies order when no mixed tool ordering is needed.
    context.messages.forEach(message);
  }
  if (Array.isArray(context.turnResults)) for (const value of context.turnResults) {
    const result = record(value);
    const item = turns.find(item => item.turnId === result.turnId);
    if (!item) continue;
    if (result.outcome === 'completed') item.status = 'completed';
    else if (result.outcome === 'cancelled' || result.outcome === 'interrupted') item.status = 'aborted';
    else if (result.outcome === 'failed') item.status = 'failed';
  }
  const active = turns.find(item => item.turnId === activeTurnId);
  if (active && (status === 'running' || status === 'awaiting_interaction')) active.status = 'streaming';
  if (context.reasoningIdentity && typeof context.reasoning === 'string') {
    const owner = record(context.reasoningIdentity);
    if (typeof owner.turnId === 'string') {
      const item = turns.find(item => item.turnId === owner.turnId);
      if (item) item.reasoning = text(context.reasoning);
    }
  }
  return turns;
}
