import { applyNativeState } from './native-state';
import {
  parsePendingInteraction,
  Term2ProtocolError,
  type AgentEventEnvelope,
  type AgentChangeV2,
  type Term2AcceptedChange,
  type Term2LiveChange,
  type InteractionProjection,
  type PendingInteraction,
  type Term2Command,
  type Term2SessionView,
  type Term2SubagentCard,
  type Term2TurnItem,
  type Term2TurnView,
} from './types';

const MAX_VIEW_TEXT = 100_000;
function text(value: unknown, max = MAX_VIEW_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Term2ProtocolError('Missing opaque event identity');
  return value;
}
function payloadId(payload: Record<string, unknown>, key: string): string {
  return id(payload[key]);
}
function turn(view: Term2SessionView, turnId: string): Term2TurnView {
  const existing = view.turns.find((item) => item.turnId === turnId) ?? view.retiredTurns?.find(item => item.turnId === turnId);
  if (existing) return existing;
  const created: Term2TurnView = {
    turnId,
    role: 'assistant',
    text: '',
    reasoning: '',
    status: 'streaming',
    commands: [],
  };
  view.turns.push(created);
  return created;
}
function command(view: Term2TurnView, callId: string, toolName = 'Tool'): Term2Command {
  const existing = view.commands.find((item) => item.callId === callId);
  if (existing) return existing;
  const created: Term2Command = { callId, toolName, status: 'pending' };
  view.commands.push(created);
  return created;
}
/** Every real command message stays visible, even several messages for one call.
 * Reuse a running placeholder only once; never key result multiplicity by callId alone. */
function commandMessage(commands: Term2Command[], payload: Readonly<Record<string, unknown>>): Term2Command {
  const callId = payloadId(payload, 'callId');
  const message = payload.message;
  const messageId = message && typeof message === 'object' && !Array.isArray(message)
    ? id((message as Record<string, unknown>).id) : undefined;
  const existing = (messageId === undefined ? undefined : commands.find(item => item.messageId === messageId)) ??
    commands.find(item => item.callId === callId && item.messageId === undefined && ['pending', 'running'].includes(item.status));
  const actualName = typeof payload.toolName === 'string' ? payload.toolName : commands.find(item => item.callId === callId)?.toolName;
  if (!actualName) throw new Term2ProtocolError('Command result has no accepted tool name');
  const entry: Term2Command = existing ?? { callId, toolName: actualName, status: 'pending' };
  if (messageId !== undefined) entry.messageId = messageId;
  if (!existing) commands.push(entry);
  return entry;
}
function turnForCommand(view: Term2SessionView, turnId: string): Term2TurnView {
  const sameTurn = view.turns.find((item) => item.turnId === turnId && item.role === 'assistant');
  if (sameTurn) return sameTurn;
  const userIndex = view.turns.findIndex((item) => item.turnId === turnId && item.role === 'user');
  const following = userIndex >= 0 ? view.turns[userIndex + 1] : undefined;
  if (following?.role === 'assistant') return following;
  return turn(view, turnId);
}
function settleCommands(turnView: Term2TurnView, status: 'completed' | 'failed' | 'aborted'): void {
  for (const entry of turnView.commands) {
    if (entry.status === 'pending' || entry.status === 'running') entry.status = status;
  }
}
const COMMAND_MESSAGE_WIRE_STATUSES = ['pending', 'running', 'completed', 'failed', 'aborted'];
// Failure codes published by the gateway for turn_failed (M4 DTO spec).
const TURN_FAILURE_REASONS = new Set([
  'provider_error',
  'network_error',
  'rate_limit',
  'authentication_error',
  'cancelled',
  'validation_error',
  'compaction_failed',
  'interaction_continuation_failed',
  'retry_exhausted',
  'runtime_error',
]);
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function turnForActivity(view: Term2SessionView, turnId: string): Term2TurnView {
  const existing = view.turns.find((item) => item.turnId === turnId && item.role === 'assistant') ?? view.retiredTurns?.find(item => item.turnId === turnId && item.role === 'assistant');
  if (existing) return existing;
  const userIndex = view.turns.findIndex((item) => item.turnId === turnId && item.role === 'user');
  const following = userIndex >= 0 ? view.turns[userIndex + 1] : undefined;
  if (following?.role === 'assistant') return following;
  const created = turn(view, turnId);
  // Async card events can arrive for an already settled turn; a turn created
  // here only hosts the card and must not read as live.
  if (view.status !== 'running' && view.status !== 'awaiting_interaction') created.status = 'completed';
  return created;
}
function subagentCard(turnView: Term2TurnView, agentId: string, role: string): Term2SubagentCard {
  const existing = turnView.subagents?.find((card) => card.agentId === agentId);
  if (existing) return existing;
  const created: Term2SubagentCard = { agentId, role, status: 'running', commands: [] };
  if (turnView.subagents) turnView.subagents.push(created);
  else turnView.subagents = [created];
  return created;
}
function upsertCardCommand(card: Term2SubagentCard, entry: Record<string, unknown>): void {
  const callId = entry.callId;
  const status = entry.status;
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) return;
  if (!COMMAND_MESSAGE_WIRE_STATUSES.includes(String(status))) return;
  const toolName =
    typeof entry.toolName === 'string' && entry.toolName.length > 0 ? entry.toolName.slice(0, 256) : 'Tool';
  const existing = card.commands.find((item) => item.callId === callId);
  const command: Term2Command = existing ?? { callId, toolName, status: 'pending' };
  command.toolName = toolName;
  command.status = status as Term2Command['status'];
  if (entry.output !== undefined) command.output = text(entry.output);
  if (entry.error !== undefined) command.error = text(entry.error, 10_000);
  if (!existing) card.commands.push(command);
}
function removeTrailingInterruptedTurns(view: Term2SessionView): void {
  while (view.turns.at(-1)?.turnId.startsWith('system-interrupted-')) view.turns.pop();
}
function completedTurn(view: Term2SessionView, turnId: string, payloadText: unknown): Term2TurnView {
  const boundedText = text(payloadText);
  const userIndex = view.turns.findIndex((item) => item.turnId === turnId && item.role === 'user');
  const following = userIndex >= 0 ? view.turns[userIndex + 1] : undefined;
  const existing =
    view.turns.find((item) => item.turnId === turnId && item.role === 'assistant') ||
    (following?.role === 'assistant' && following.text === boundedText ? following : undefined);
  if (existing) {
    if (!existing.text && payloadText !== undefined) existing.text = boundedText;
    return existing;
  }
  const created: Term2TurnView = {
    turnId,
    role: 'assistant',
    text: boundedText,
    reasoning: '',
    status: 'completed',
    commands: [],
  };
  view.turns.push(created);
  return created;
}

export function emptyTerm2SessionView(sessionId: string): Term2SessionView {
  return {
    sessionId,
    turns: [],
    pendingInteraction: null,
    status: 'idle',
    lastAppliedSequence: 0,
    error: null,
    reloadRequired: false,
  };
}

function replaceInteraction(view: Term2SessionView, interaction: InteractionProjection): void {
  view.pendingInteraction = interaction;
  view.status =
    interaction?.state === 'pending'
      ? 'awaiting_interaction'
      : view.status === 'awaiting_interaction'
      ? 'running'
      : view.status;
}

/** Install one accepted boundary atomically. Sparse native seq values are checkpoints,
 * not a count of projected changes. Live changes cannot advance that checkpoint. */
export function applyTerm2Event(previous: Term2SessionView, event: AgentEventEnvelope): Term2SessionView {
  if (event.sessionId !== previous.sessionId) throw new Term2ProtocolError('Event belongs to another session');
  if (event.kind === 'accepted' && event.seq <= previous.lastAppliedSequence) return previous;
  let next = previous;
  if (event.kind === 'live') {
    for (const change of event.changes) next = routeChange(next, change, view => applyLiveChange(view, change));
    return { ...next, lastAppliedSequence: previous.lastAppliedSequence };
  }
  // Narrowing by envelope kind uses the authoritative accepted Extract, never
  // the general (accepted-or-live) change union as accepted admission.
  for (const change of event.changes) {
    next = routeChange(next, change, view => applyAcceptedChange(view, change));
    if (change.type === 'request_cost_recorded' && next.branches) {
      next = { ...next, branches: Object.fromEntries(Object.entries(next.branches).map(([key, branch]) => {
        const requestCosts = next.nativeState?.requestCosts?.filter(item => item.turnId === branch.identity.turnId);
        return [key, { ...branch, view: { ...branch.view, nativeState: { ...branch.view.nativeState, requestCosts } } }];
      })) };
    }
  }
  return { ...next, lastAppliedSequence: event.seq };
}

function routeChange(previous: Term2SessionView, change: AgentChangeV2, apply: (view: Term2SessionView) => Term2SessionView): Term2SessionView {
  if (!change.branch) return apply(previous);
  const identity = change.branch;
  const existing = previous.branches?.[identity.branchId];
  const branchView = apply(existing?.view ?? {
    ...emptyTerm2SessionView(previous.sessionId),
    nativeState: { requestCosts: previous.nativeState?.requestCosts?.filter(item => item.turnId === identity.turnId) },
  });
  return { ...previous, reloadRequired: previous.reloadRequired || branchView.reloadRequired,
    branches: { ...previous.branches, [identity.branchId]: { identity, view: branchView } },
  };
}

function applyLiveChange(previous: Term2SessionView, event: Term2LiveChange): Term2SessionView {
  if (event.type === 'turn_failed') {
    payloadId(event.payload, 'turnId');
    if (event.payload.outcome !== 'failed' || typeof event.payload.reason !== 'string' ||
        (event.payload.finalText !== undefined && typeof event.payload.finalText !== 'string'))
      throw new Term2ProtocolError('Invalid transient failed lifecycle');
  }
  return { ...previous, liveChanges: [...(previous.liveChanges ?? []), event] };
}

function cloneTurns(turns: Term2TurnView[]): Term2TurnView[] {
  return turns.map(item => ({
    ...item,
    commands: item.commands.map(entry => ({ ...entry })),
    ...(item.items ? { items: item.items.map(entry => ({ ...entry })) } : {}),
    subagents: item.subagents?.map(card => ({ ...card, commands: card.commands.map(entry => ({ ...entry })) })),
  }));
}

function ensureTurnItems(turnView: Term2TurnView): Term2TurnItem[] {
  if (!turnView.items) turnView.items = [];
  return turnView.items;
}

function upsertTurnTextItem(
  turnView: Term2TurnView,
  messageId: string,
  content: string,
  options?: { replacesDraftId?: string; draft?: boolean; modelStep?: number },
): void {
  const items = ensureTurnItems(turnView);
  const replaces = options?.replacesDraftId;
  let index = replaces ? items.findIndex((entry) => entry.kind === 'text' && entry.id === replaces) : -1;
  if (index < 0) index = items.findIndex((entry) => entry.kind === 'text' && entry.id === messageId);
  if (index < 0) index = items.findIndex((entry) => entry.kind === 'text' && entry.id === '__stream_text__');
  if (content.length === 0) {
    turnView.items = items.filter(
      (entry) =>
        !(
          entry.kind === 'text' &&
          (entry.id === messageId || (replaces && entry.id === replaces) || entry.id === '__stream_text__')
        ),
    );
    return;
  }
  const next: Term2TurnItem = {
    kind: 'text',
    id: messageId,
    text: content,
    ...(options?.draft ? { draft: true } : {}),
    ...(options?.modelStep !== undefined ? { modelStep: options.modelStep } : {}),
  };
  if (index >= 0) {
    items[index] = next;
    turnView.items = items.filter(
      (entry, pos) =>
        pos === index ||
        !(
          entry.kind === 'text' &&
          (entry.id === messageId || (replaces && entry.id === replaces) || entry.id === '__stream_text__')
        ),
    );
  } else {
    items.push(next);
  }
}

function upsertTurnUserItem(turnView: Term2TurnView, messageId: string, content: string): void {
  const items = ensureTurnItems(turnView);
  const index = items.findIndex((entry) => entry.kind === 'user' && entry.id === messageId);
  if (content.length === 0) {
    if (index >= 0) turnView.items = items.filter((_, pos) => pos !== index);
    return;
  }
  const next: Term2TurnItem = { kind: 'user', id: messageId, text: content };
  if (index >= 0) items[index] = next;
  else items.push(next);
}

function removeTurnTextIds(turnView: Term2TurnView, ids: readonly (string | undefined)[]): void {
  if (!turnView.items) return;
  const targets = new Set(ids.filter((value): value is string => Boolean(value)));
  if (targets.size === 0) return;
  turnView.items = turnView.items.filter((entry) => !(entry.kind === 'text' && targets.has(entry.id)));
}

function upsertTurnReasoningItem(
  turnView: Term2TurnView,
  reasoningId: string,
  content: string,
  options?: { modelStep?: number; streaming?: boolean },
): void {
  if (!content.trim()) return;
  const items = ensureTurnItems(turnView);
  let existingIndex = items.findIndex((entry) => entry.kind === 'reasoning' && entry.id === reasoningId);
  if (existingIndex < 0) {
    existingIndex = items.findIndex((entry) => entry.kind === 'reasoning' && entry.id === '__stream_reasoning__');
  }
  const next: Term2TurnItem = {
    kind: 'reasoning',
    id: reasoningId,
    text: content,
    ...(options?.streaming ? { streaming: true } : {}),
    ...(options?.modelStep !== undefined ? { modelStep: options.modelStep } : {}),
  };
  if (existingIndex >= 0) {
    items[existingIndex] = next;
    return;
  }
  const stepTextIndex = items.findIndex(
    (entry) =>
      entry.kind === 'text' &&
      ((options?.modelStep !== undefined && entry.modelStep === options.modelStep) ||
        entry.id === '__stream_text__' ||
        entry.draft === true),
  );
  if (stepTextIndex >= 0) {
    items.splice(stepTextIndex, 0, next);
    return;
  }
  items.push(next);
}

function ensureTurnToolItem(turnView: Term2TurnView, executionId: string): void {
  const items = ensureTurnItems(turnView);
  if (!items.some((entry) => entry.kind === 'tool' && entry.executionId === executionId)) {
    items.push({ kind: 'tool', executionId });
  }
}

function settleStreamingItems(turnView: Term2TurnView): void {
  if (!turnView.items) return;
  for (const entry of turnView.items) {
    if (entry.kind === 'reasoning' && entry.streaming) entry.streaming = false;
    if (entry.kind === 'text' && entry.draft) entry.draft = false;
  }
}

/** Drop only connection-local UI observations, never accepted summaries, native
 * tool results or provider history. Live frames have no recovery cursor. */
export function clearTerm2LiveEvidence(view: Term2SessionView): Term2SessionView {
  return { ...view, liveChanges: undefined,
    ...(view.branches ? { branches: Object.fromEntries(Object.entries(view.branches).map(([key, branch]) => [key, { ...branch, view: clearTerm2LiveEvidence(branch.view) }])) } : {}),
  };
}

/** Transient lifecycle affects presentation only. Accepted state/checkpoint stay
 * intact; dropping connection-local observations removes this overlay. */
export function presentTerm2SessionView(view: Term2SessionView): Term2SessionView {
  const failure = view.liveChanges?.slice().reverse().find(change => change.type === 'turn_failed');
  const payload = failure?.payload;
  const liveReasoningByTurn = new Map<string, string>();
  const activeStreamingTurnId = view.turns.find((t) => t.status === 'streaming')?.turnId;
  if (view.liveChanges) {
    for (const change of view.liveChanges) {
      if (change.type !== 'reasoning_delta') continue;
      const turnId =
        typeof change.payload.turnId === 'string' && change.payload.turnId.length > 0
          ? change.payload.turnId
          : activeStreamingTurnId;
      const delta = typeof change.payload.delta === 'string' ? change.payload.delta : '';
      if (!turnId || !delta) continue;
      liveReasoningByTurn.set(turnId, (liveReasoningByTurn.get(turnId) ?? '') + delta);
    }
  }
  const hasOverlay = Boolean(payload || liveReasoningByTurn.size > 0);
  const turns = hasOverlay
    ? view.turns.map((turnItem) => {
        let updated = turnItem;
        const liveReasoning = liveReasoningByTurn.get(turnItem.turnId);
        if (liveReasoning && liveReasoning.trim().length > 0) {
          const baseItems = updated.items ? [...updated.items] : [];
          const existingStreamIdx = baseItems.findIndex(
            (entry) => entry.kind === 'reasoning' && entry.id === '__stream_reasoning__',
          );
          const lastReasoning = [...baseItems].reverse().find((entry) => entry.kind === 'reasoning');
          const liveBlock: Term2TurnItem = {
            kind: 'reasoning',
            id: '__live_reasoning__',
            text: liveReasoning,
            streaming: true,
          };
          if (existingStreamIdx >= 0) {
            baseItems[existingStreamIdx] = liveBlock;
          } else if (!lastReasoning || lastReasoning.text !== liveReasoning) {
            const draftTextIdx = baseItems.findIndex(
              (entry) => entry.kind === 'text' && (entry.id === '__stream_text__' || entry.draft === true),
            );
            if (draftTextIdx >= 0) {
              baseItems.splice(draftTextIdx, 0, liveBlock);
            } else {
              baseItems.push(liveBlock);
            }
          }
          updated = {
            ...updated,
            reasoning: updated.reasoning ? updated.reasoning : liveReasoning,
            items: baseItems,
          };
        }
        if (payload && updated.turnId === payload.turnId) {
          const finalText = typeof payload.finalText === 'string' ? payload.finalText : undefined;
          let nextItems = updated.items;
          if (finalText && finalText.length > 0 && updated.items && updated.items.length > 0) {
            nextItems = [...updated.items];
            const existingIdx = nextItems.findIndex(
              (entry) => entry.kind === 'text' && (entry.id === '__live_final__' || entry.id === '__stream_text__'),
            );
            const finalItem: Term2TurnItem = { kind: 'text', id: '__live_final__', text: finalText };
            if (existingIdx >= 0) nextItems[existingIdx] = finalItem;
            else nextItems.push(finalItem);
          }
          updated = {
            ...updated,
            status: 'failed' as const,
            transientFailure: true,
            transientStatus: undefined,
            error: typeof payload.reason === 'string' ? payload.reason : undefined,
            ...(finalText !== undefined ? { text: finalText } : {}),
            ...(nextItems !== updated.items ? { items: nextItems } : {}),
          };
        }
        return updated;
      })
    : view.turns;
  return {
    ...view,
    ...(hasOverlay ? { turns } : {}),
    ...(view.branches
      ? {
          branches: Object.fromEntries(
            Object.entries(view.branches).map(([key, branch]) => [
              key,
              { ...branch, view: presentTerm2SessionView(branch.view) },
            ]),
          ),
        }
      : {}),
  };
}

function applyAcceptedChange(previous: Term2SessionView, event: Term2AcceptedChange): Term2SessionView {
  const clearsLiveFailure = [
    'assistant_started',
    'turn_completed',
    'turn_failed',
    'turn_aborted',
    'session_rotated',
    'history_replaced',
  ].includes(event.type);
  const clearsLiveReasoning = [
    'reasoning',
    'tool_called',
    'turn_completed',
    'turn_failed',
    'turn_aborted',
    'session_rotated',
    'history_replaced',
  ].includes(event.type);
  const view: Term2SessionView = {
    ...previous,
    turns: cloneTurns(previous.turns),
    retiredTurns: previous.retiredTurns ? cloneTurns(previous.retiredTurns) : undefined,
    error: null,
    // New native accepted lifecycle supersedes prior connection-local observations.
    liveChanges:
      clearsLiveFailure || clearsLiveReasoning
        ? previous.liveChanges?.filter(
            (change) =>
              !(clearsLiveFailure && change.type === 'turn_failed') &&
              !(clearsLiveReasoning && change.type === 'reasoning_delta'),
          )
        : previous.liveChanges,
  };
  const payload: Readonly<Record<string, unknown>> = event.payload;
  switch (event.type) {
    case 'tool_called': {
      const native = payload.tool;
      if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Term2ProtocolError('Missing accepted tool call');
      const tool = native as Readonly<Record<string, unknown>>;
      const executionId = id(tool.executionId);
      const turnId = id(tool.turnId);
      const toolName = id(tool.toolName);
      if (tool.status !== 'called' || !('input' in tool)) throw new Term2ProtocolError('Invalid accepted tool call');
      let item = view.turns.find(item => item.turnId === turnId);
      if (!item) { item = { turnId, role: 'assistant', text: '', reasoning: '', status: 'unknown', commands: [], items: [] }; view.turns.push(item); }
      const entry = command(item, executionId, toolName);
      entry.nativeTool = tool;
      entry.toolName = toolName;
      entry.argumentsText = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input);
      ensureTurnToolItem(item, executionId);
      // Called is pending, not a physical start or a foreground status change.
      break;
    }
    case 'message': {
      view.nativeState = applyNativeState(previous.nativeState, event);
      // Native message/draft IDs select replacement and actual turnId selects
      // presentation. No adjacency, content match or synthetic assistant turn.
      const incoming = view.nativeState.messages!.find(entry => entry.message === payload.message)!;
      const replacedId = incoming.replacesDraftId ?? incoming.message.replacesDraftId;
      const affected = [incoming, ...(previous.nativeState?.messages ?? []).filter(entry =>
        entry.message.id === incoming.message.id || entry.message.id === replacedId)];
      const owners = new Set(affected.flatMap(({ message }) => message.turnId === undefined ? [] : [message.turnId]));
      for (const turnId of owners) {
        const messages = view.nativeState.messages?.filter(entry => entry.message.turnId === turnId).map(entry => entry.message) ?? [];
        let item = view.turns.find(item => item.turnId === turnId);
        if (!item && messages.some(message => message.role !== 'tool')) {
          item = { turnId, role: 'assistant', text: '', reasoning: '', status: 'unknown', commands: [], items: [] };
          view.turns.push(item);
        }
        if (!item) continue;
        item.role = 'assistant';
        const users = messages.filter(message => message.role === 'user');
        if (incoming.message.turnId === turnId && incoming.message.role === 'user') {
          if (item.userMessageId === undefined && item.userText === undefined && (item.items?.length ?? 0) === 0) {
            item.userMessageId = incoming.message.id;
            item.userText = incoming.message.text;
          } else if (incoming.message.id === item.userMessageId) {
            item.userText = incoming.message.text;
          } else {
            upsertTurnUserItem(item, incoming.message.id, incoming.message.text);
          }
        } else if (item.userMessageId !== undefined) {
          const opening = users.find(message => message.id === item.userMessageId);
          item.userText = opening ? opening.text : undefined;
        } else if (users.length === 0) {
          item.userText = undefined;
        }
        item.text = messages
          .filter(message => message.role === 'assistant')
          .map(message => message.text)
          .filter(chunk => chunk.length > 0)
          .join('\n\n');
        if (incoming.message.turnId === turnId && incoming.message.role === 'assistant') {
          upsertTurnTextItem(item, incoming.message.id, incoming.message.text, {
            replacesDraftId: replacedId,
            draft: incoming.message.draft,
            modelStep: incoming.message.modelStep,
          });
        } else {
          removeTurnTextIds(item, [incoming.message.id, replacedId]);
        }
      }
      break;
    }
    case 'task_changed':
      view.nativeState = applyNativeState(previous.nativeState, event);
      if (previous.rootEvidence) view.rootEvidence = { ...previous.rootEvidence, tasks: view.nativeState.tasks };
      // at/change are retained evidence, not a cursor/clock or a foreground terminal.
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      break;
    case 'cost':
    case 'request_cost_recorded':
    case 'goal':
    case 'goal_proposed':
    case 'verification':
    case 'notice':
    case 'background_notice_enqueued':
    case 'background_notices_delivered':
      view.nativeState = applyNativeState(previous.nativeState, event);
      break;
    case 'session_created':
      view.status = 'connected';
      break;
    case 'user_message_accepted': {
      const turnId = payloadId(payload, 'turnId');
      if (payload.messageId !== turnId) throw new Term2ProtocolError('Message and turn identities differ');
      if (!view.turns.some((item) => item.turnId === turnId))
        view.turns.push({
          turnId,
          role: 'user',
          text: text(payload.text),
          reasoning: '',
          status: 'completed',
          commands: [],
        });
      break;
    }
    case 'user_message_rejected': {
      const item = turn(view, payloadId(payload, 'turnId'));
      item.role = 'user';
      item.status = 'rejected';
      item.error = 'Queued message was discarded';
      break;
    }
    case 'assistant_started': {
      const item = turn(view, payloadId(payload, 'turnId'));
      if (item.role === 'user') {
        item.userText = item.text;
        item.text = '';
        item.role = 'assistant';
      }
      item.status = 'streaming';
      view.status = 'running';
      break;
    }
    case 'text_delta': {
      const targetTurn = turn(view, payloadId(payload, 'turnId'));
      const delta = text(payload.delta);
      targetTurn.text += delta;
      if (delta) {
        const items = ensureTurnItems(targetTurn);
        const last = items.at(-1);
        if (last && last.kind === 'text' && last.id === '__stream_text__') {
          last.text += delta;
        } else {
          items.push({ kind: 'text', id: '__stream_text__', text: delta, draft: true });
        }
      }
      view.status = 'running';
      break;
    }
    case 'reasoning': {
      // Native messageId/modelStep is not a v1 turn identity. Preserve it exactly.
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const reasoningText = text(payload.text);
      if (reasoningText.trim().length > 0) {
        const explicitTurnId = typeof payload.turnId === 'string' ? payload.turnId : undefined;
        const targetTurn =
          (explicitTurnId ? view.turns.find((t) => t.turnId === explicitTurnId) : undefined) ??
          view.turns.find((t) => t.status === 'streaming');
        if (targetTurn) {
          const messageId =
            typeof payload.messageId === 'string' && payload.messageId.length > 0
              ? payload.messageId
              : `reasoning:${targetTurn.items?.length ?? 0}`;
          const modelStep = typeof payload.modelStep === 'number' ? payload.modelStep : undefined;
          upsertTurnReasoningItem(targetTurn, messageId, reasoningText, { modelStep });
          targetTurn.reasoning = (targetTurn.items ?? [])
            .filter((entry): entry is Extract<Term2TurnItem, { kind: 'reasoning' }> => entry.kind === 'reasoning')
            .map((entry) => entry.text)
            .join('\n\n');
        }
      }
      break;
    }
    case 'reasoning_delta': {
      const targetTurn = turn(view, payloadId(payload, 'turnId'));
      const delta = text(payload.delta);
      targetTurn.reasoning += delta;
      if (delta) {
        const items = ensureTurnItems(targetTurn);
        const last = items.at(-1);
        if (last && last.kind === 'reasoning' && last.id === '__stream_reasoning__') {
          last.text += delta;
        } else {
          items.push({ kind: 'reasoning', id: '__stream_reasoning__', text: delta, streaming: true });
        }
      }
      view.status = 'running';
      break;
    }
    case 'tool_started': {
      const item = turnForCommand(view, payloadId(payload, 'turnId'));
      const callId = payloadId(payload, 'callId');
      const entry = command(item, callId, text(payload.toolName, 256) || 'Tool');
      entry.status = 'running';
      if (payload.argumentsText !== undefined) entry.argumentsText = text(payload.argumentsText, 8192);
      ensureTurnToolItem(item, callId);
      view.status = 'running';
      break;
    }
    case 'command_message': {
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const turnId = payloadId(payload, 'turnId');
      const callId = payloadId(payload, 'callId');
      const item = view.turns.find(item => item.turnId === turnId);
      const status = payload.status;
      if (!['pending', 'running', 'completed', 'failed', 'aborted'].includes(String(status)))
        throw new Term2ProtocolError('Invalid command status');
      // Keep an unmatched result as exact evidence, not a guessed Tool card.
      if (!item?.commands.some(entry => entry.callId === callId)) break;
      const entry = commandMessage(item.commands, payload);
      entry.status = status as Term2Command['status'];
      if (payload.output !== undefined) entry.output = text(payload.output);
      if (payload.error !== undefined) entry.error = text(payload.error, 10_000);
      break;
    }
    case 'approval_required':
    case 'interaction_updated': {
      const interaction = parsePendingInteraction(payload.interaction);
      const turnId = payloadId(payload, 'turnId');
      if (event.type === 'interaction_updated' && view.pendingInteraction?.state === 'pending') {
        if (
          interaction.interactionId !== view.pendingInteraction.interaction.interactionId ||
          interaction.revision <= view.pendingInteraction.interaction.revision
        )
          throw new Term2ProtocolError('Stale interaction update');
      }
      replaceInteraction(view, { state: 'pending', interaction, turnId });
      break;
    }
    case 'interaction_resolved': {
      const interactionId = id(payload.interactionId);
      if (!['approved', 'rejected', 'cancelled', 'continued'].includes(String(payload.outcome)))
        throw new Term2ProtocolError('Invalid interaction outcome');
      if (view.pendingInteraction && view.pendingInteraction.interaction.interactionId !== interactionId)
        throw new Term2ProtocolError('Resolved interaction is not current');
      replaceInteraction(view, null);
      // Like the TUI reducer: a resolution resumes a running root turn; a background task's
      // approval resolved while the chat is idle leaves it idle.
      view.status = view.turns.some((turn) => turn.status === 'streaming' || turn.status === 'pending')
        ? 'running'
        : 'connected';
      break;
    }
    case 'interaction_recovered': {
      const interaction = parsePendingInteraction(payload.interaction);
      replaceInteraction(view, {
        state: 'recovered',
        interaction,
        turnId: payloadId(payload, 'turnId'),
        resolvable: false,
        reason: payload.reason as 'daemon_restart' | 'forced_shutdown' | 'persistence_recovery',
      });
      view.status = 'interrupted';
      break;
    }
    case 'usage_update': {
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      // Sessions replayed from before the M4 fix only carry the nested shape,
      // and that shape had only inputTokens/outputTokens — no totalTokens.
      const nested =
        payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
          ? (payload.usage as Record<string, unknown>)
          : undefined;
      const inputTokens = tokenCount(payload.inputTokens) ?? tokenCount(nested?.inputTokens);
      const outputTokens = tokenCount(payload.outputTokens) ?? tokenCount(nested?.outputTokens);
      item.usage = {
        inputTokens,
        outputTokens,
        totalTokens:
          tokenCount(payload.totalTokens) ??
          tokenCount(nested?.totalTokens) ??
          (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
      };
      break;
    }
    case 'retry': {
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      const attempt = tokenCount(payload.attempt);
      const maxRetries = tokenCount(payload.maxRetries);
      // The gateway clamps absent counters to 0; a real retry attempt starts at 1.
      if (attempt !== undefined && attempt >= 1 && maxRetries !== undefined)
        item.transientStatus = `retrying (attempt ${attempt}/${maxRetries})`;
      break;
    }
    case 'retry_exhausted': {
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = 'retries exhausted';
      break;
    }
    case 'subagent_started': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      card.status = 'running';
      if (payload.task !== undefined) card.task = text(payload.task, 16_384);
      card.async = payload.async === true ? true : undefined;
      break;
    }
    case 'subagent_tool_started': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      upsertCardCommand(card, {
        callId: payloadId(payload, 'toolCallId'),
        toolName: text(payload.toolName, 256) || 'Tool',
        status: 'running',
      });
      if (Array.isArray(payload.commandMessages)) {
        for (const entry of payload.commandMessages.slice(0, 64)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          upsertCardCommand(card, entry as Record<string, unknown>);
        }
      }
      break;
    }
    case 'subagent_text_turn': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      card.progressText = text(payload.text, 16_384);
      break;
    }
    case 'subagent_command_message': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      if (!COMMAND_MESSAGE_WIRE_STATUSES.includes(String(payload.status)))
        throw new Term2ProtocolError('Invalid command status');
      upsertCardCommand(card, {
        callId: payloadId(payload, 'callId'),
        toolName: text(payload.toolName, 256) || 'Tool',
        status: payload.status,
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {}),
      });
      break;
    }
    case 'subagent_completed': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(String(payload.status)))
        throw new Term2ProtocolError('Invalid subagent status');
      card.status = payload.status as Term2SubagentCard['status'];
      if (payload.name !== undefined) card.name = text(payload.name, 256);
      card.finalText = text(payload.finalText, 16_384);
      card.finalTextTruncated = payload.finalTextTruncated === true ? true : undefined;
      card.progressText = undefined;
      if (payload.error !== undefined) card.error = text(payload.error, 8_192);
      if (Array.isArray(payload.toolsUsed)) {
        card.toolsUsed = payload.toolsUsed.slice(0, 64).flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          const count = tokenCount(entry.count);
          if (typeof entry.toolName !== 'string' || entry.toolName.length === 0 || count === undefined) return [];
          return [{ toolName: entry.toolName.slice(0, 256), count }];
        });
      }
      if (payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)) {
        const usage = payload.usage as Record<string, unknown>;
        card.usage = {
          inputTokens: tokenCount(usage.inputTokens),
          outputTokens: tokenCount(usage.outputTokens),
          totalTokens: tokenCount(usage.totalTokens),
        };
      }
      card.async = payload.async === true ? true : undefined;
      break;
    }
    case 'subagent_interrupted': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      card.status = 'interrupted';
      card.finalText = text(payload.finalText, 16_384);
      card.progressText = undefined;
      break;
    }
    case 'subagent_approval_required': {
      const interaction = parsePendingInteraction(payload.interaction);
      replaceInteraction(view, {
        state: 'pending',
        interaction,
        turnId: payloadId(payload, 'turnId'),
        subagent: {
          agentId: payloadId(payload, 'agentId'),
          role: text(payload.role, 256) || 'subagent',
        },
      });
      break;
    }
    case 'subagent_question': {
      const card = subagentCard(
        turnForActivity(view, payloadId(payload, 'turnId')),
        payloadId(payload, 'agentId'),
        text(payload.role, 256) || 'subagent',
      );
      if (typeof payload.question === 'string') card.progressText = text(payload.question, 8_192);
      // The answerable DTO arrives as a normal PendingInteractionDto; present it
      // when the frame carries one so the question is resolvable immediately.
      if (payload.interaction !== undefined) {
        replaceInteraction(view, {
          state: 'pending',
          interaction: parsePendingInteraction(payload.interaction),
          turnId: payloadId(payload, 'turnId'),
          subagent: { agentId: card.agentId, role: card.role },
        });
      }
      break;
    }
    case 'task_progress': {
      // Like the TUI reducer: keep the task's latest step and time current, so the running
      // tasks panel can say what it is doing. Output text itself stays in the evidence list.
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;
      const at = typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : undefined;
      const tasks = previous.nativeState?.tasks;
      if (taskId && at !== undefined && tasks?.some((item) => item.id === taskId)) {
        const observation =
          payload.observation && typeof payload.observation === 'object' && !Array.isArray(payload.observation)
            ? payload.observation
            : undefined;
        view.nativeState = {
          ...previous.nativeState,
          tasks: tasks.map((item) =>
            item.id === taskId ? { ...item, lastActivityAt: at, ...(observation ? { lastObservation: observation } : {}) } : item,
          ),
        };
      }
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      break;
    }
    case 'queue_changed':
    case 'automatic_memory_notice':
    case 'command_started':
    case 'command_finished':
    case 'configuration':
    case 'tool_progress':
    case 'tool_call_streaming_delta':
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      break;
    case 'session_rotated':
      // Native rotation replaces ROOT provider context, not tasks/queue/costs.
      // Keep native evidence and branches; do not invent a reset/usage event.
      // Keep measured usage/task cards, not predecessor root text/reasoning/tools.
      view.retiredTurns = [
        ...(previous.retiredTurns ?? []),
        ...previous.turns.map(item => ({ ...item, text: '', userText: undefined, reasoning: '', commands: [], items: undefined })),
      ];
      view.hydration = undefined;
      if (previous.nativeState) view.nativeState = { ...previous.nativeState, messages: undefined };
      view.turns = [];
      view.pendingInteraction = null;
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      break;
    case 'history_replaced':
      // Transcript shape belongs to the session projection, not the event DTO.
      // Force hydration from a real accepted cut rather than guessing messages.
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      view.reloadRequired = true;
      break;
    case 'context_compaction_started': {
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = 'compacting context…';
      break;
    }
    case 'context_compaction_completed': {
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = undefined;
      break;
    }
    case 'context_compaction_failed': {
      view.nativeChanges = [...(previous.nativeChanges ?? []), event];
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = 'compaction failed';
      break;
    }
    case 'turn_completed': {
      removeTrailingInterruptedTurns(view);
      const item = completedTurn(view, payloadId(payload, 'turnId'), payload.text);
      settleCommands(item, 'completed');
      settleStreamingItems(item);
      if (item.text && (!item.items || !item.items.some((entry) => entry.kind === 'text'))) {
        upsertTurnTextItem(item, `${item.turnId}:final`, item.text);
      }
      item.status = 'completed';
      item.transientStatus = undefined;
      view.status = 'connected';
      break;
    }
    case 'turn_failed': {
      removeTrailingInterruptedTurns(view);
      const item = turn(view, payloadId(payload, 'turnId'));
      settleCommands(item, 'failed');
      settleStreamingItems(item);
      item.status = 'failed';
      item.transientStatus = undefined;
      item.error =
        typeof payload.reason === 'string' && TURN_FAILURE_REASONS.has(payload.reason)
          ? payload.reason
          : 'runtime_error';
      item.errorMessage =
        typeof payload.errorMessage === 'string' && payload.errorMessage.trim().length > 0
          ? text(payload.errorMessage, 4_096)
          : undefined;
      if (typeof payload.finalText === 'string') {
        const finalText = text(payload.finalText, 16_384);
        item.text = finalText;
        if (finalText.length > 0 && item.items && item.items.length > 0) {
          upsertTurnTextItem(item, `${item.turnId}:final`, finalText);
        }
      }
      // The failure stays on the turn. The session can take the next prompt.
      view.status = 'connected';
      view.error = null;
      break;
    }
    case 'turn_aborted': {
      const item = turn(view, payloadId(payload, 'turnId'));
      settleCommands(item, 'aborted');
      settleStreamingItems(item);
      item.status = 'aborted';
      item.transientStatus = undefined;
      view.status = 'interrupted';
      break;
    }
    default:
      throw new Term2ProtocolError('Unsupported term2 event');
  }
  return view;
}
