import {
  parsePendingInteraction,
  parseProjection,
  Term2ProtocolError,
  type AgentEventEnvelope,
  type InteractionProjection,
  type PendingInteraction,
  type SessionProjection,
  type Term2Command,
  type Term2SessionView,
  type Term2SubagentCard,
  type Term2TurnView,
} from './types';

const MAX_VIEW_TEXT = 100_000;
function text(value: unknown, max = MAX_VIEW_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value))
    throw new Term2ProtocolError('Missing opaque event identity');
  return value;
}
function payloadId(payload: Record<string, unknown>, key: string): string {
  return id(payload[key]);
}
function turn(view: Term2SessionView, turnId: string): Term2TurnView {
  const existing = view.turns.find((item) => item.turnId === turnId);
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
  const existing = view.turns.find((item) => item.turnId === turnId && item.role === 'assistant');
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
    projection: null,
    turns: [],
    pendingInteraction: null,
    status: 'idle',
    lastAppliedSequence: 0,
    error: null,
    reloadRequired: false,
  };
}

function transcriptCommands(value: unknown): Term2Command[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const status = item.status;
    if (
      typeof item.callId !== 'string' ||
      item.callId.length === 0 ||
      typeof item.toolName !== 'string' ||
      item.toolName.length === 0 ||
      !['completed', 'failed', 'aborted', 'unknown'].includes(String(status))
    )
      return [];
    return [
      {
        callId: text(item.callId, 256),
        toolName: text(item.toolName, 256),
        status: status as Term2Command['status'],
      },
    ];
  });
}

function transcriptTurns(projection: SessionProjection): Term2TurnView[] {
  const root =
    projection.transcript && typeof projection.transcript === 'object'
      ? (projection.transcript as Record<string, unknown>)
      : {};
  const entries = Array.isArray(root.messages) ? root.messages : Array.isArray(root.items) ? root.items : [];
  const parsed = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const turnId = typeof item.turnId === 'string' ? item.turnId : typeof item.id === 'string' ? item.id : null;
    if (!turnId) return [];
    return [
      {
        turnId,
        role: item.role === 'user' ? ('user' as const) : ('assistant' as const),
        text: text(item.text ?? item.content),
        commands: transcriptCommands(item.commands),
      },
    ];
  });
  const turns: Term2TurnView[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const current = parsed[index];
    const next = parsed[index + 1];
    if (current.role === 'user' && next?.role === 'assistant' && !next.turnId.startsWith('system-interrupted-')) {
      turns.push({
        turnId: current.turnId,
        role: 'assistant',
        userText: current.text,
        text: next.text,
        reasoning: '',
        status: 'completed',
        commands: next.commands,
      });
      index += 1;
      continue;
    }
    turns.push({
      turnId: current.turnId,
      role: current.role,
      text: current.text,
      reasoning: '',
      status: 'completed',
      commands: current.commands,
    });
  }
  return turns;
}

export function viewFromProjection(projection: SessionProjection): Term2SessionView {
  const view = emptyTerm2SessionView(projection.id);
  view.projection = projection;
  view.turns = transcriptTurns(projection);
  view.pendingInteraction = projection.interaction;
  view.lastAppliedSequence = projection.projectionSequence;
  view.status =
    projection.status === 'running'
      ? 'running'
      : projection.status === 'awaiting_interaction'
      ? 'awaiting_interaction'
      : projection.status === 'interrupted'
      ? 'interrupted'
      : projection.status === 'closed'
      ? 'closed'
      : 'connected';
  return view;
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

export function applyTerm2Event(previous: Term2SessionView, event: AgentEventEnvelope): Term2SessionView {
  if (event.sessionId !== previous.sessionId) throw new Term2ProtocolError('Event belongs to another session');
  if (event.id <= previous.lastAppliedSequence) return previous;
  if (event.id !== previous.lastAppliedSequence + 1) throw new Term2ProtocolError('Term2 event sequence gap');
  const view: Term2SessionView = {
    ...previous,
    turns: previous.turns.map((item) => ({
      ...item,
      commands: item.commands.map((entry) => ({ ...entry })),
      subagents: item.subagents?.map((card) => ({
        ...card,
        commands: card.commands.map((entry) => ({ ...entry })),
      })),
    })),
    error: null,
    lastAppliedSequence: event.id,
  };
  const payload = event.payload;
  switch (event.type) {
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
    case 'text_delta':
      turn(view, payloadId(payload, 'turnId')).text += text(payload.delta);
      view.status = 'running';
      break;
    case 'reasoning_delta':
      turn(view, payloadId(payload, 'turnId')).reasoning += text(payload.delta);
      view.status = 'running';
      break;
    case 'tool_started': {
      const item = turnForCommand(view, payloadId(payload, 'turnId'));
      const callId = payloadId(payload, 'callId');
      const entry = command(item, callId, text(payload.toolName, 256) || 'Tool');
      entry.status = 'running';
      if (payload.argumentsText !== undefined) entry.argumentsText = text(payload.argumentsText, 8192);
      view.status = 'running';
      break;
    }
    case 'command_message': {
      const item = turnForCommand(view, payloadId(payload, 'turnId'));
      const entry = command(item, payloadId(payload, 'callId'), text(payload.toolName, 256) || 'Tool');
      const status = payload.status;
      if (!['pending', 'running', 'completed', 'failed', 'aborted'].includes(String(status)))
        throw new Term2ProtocolError('Invalid command status');
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
      view.status = 'running';
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
    case 'context_compaction_started': {
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = 'compacting context…';
      break;
    }
    case 'context_compaction_completed': {
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = undefined;
      break;
    }
    case 'context_compaction_failed': {
      const item = turnForActivity(view, payloadId(payload, 'turnId'));
      item.transientStatus = 'compaction failed';
      break;
    }
    case 'turn_completed': {
      removeTrailingInterruptedTurns(view);
      const item = completedTurn(view, payloadId(payload, 'turnId'), payload.text);
      settleCommands(item, 'completed');
      item.status = 'completed';
      item.transientStatus = undefined;
      view.status = 'connected';
      break;
    }
    case 'turn_failed': {
      removeTrailingInterruptedTurns(view);
      const item = turn(view, payloadId(payload, 'turnId'));
      settleCommands(item, 'failed');
      item.status = 'failed';
      item.transientStatus = undefined;
      item.error =
        typeof payload.reason === 'string' && TURN_FAILURE_REASONS.has(payload.reason)
          ? payload.reason
          : 'runtime_error';
      if (typeof payload.finalText === 'string') item.text = text(payload.finalText, 16_384);
      view.status = 'error';
      view.error = item.error;
      break;
    }
    case 'turn_aborted': {
      const item = turn(view, payloadId(payload, 'turnId'));
      settleCommands(item, 'aborted');
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

export function applyProjectionEvent(view: Term2SessionView, projection: SessionProjection): Term2SessionView {
  const next = viewFromProjection(parseProjection(projection));
  if (next.sessionId !== view.sessionId) throw new Term2ProtocolError('Projection belongs to another session');
  return next;
}
