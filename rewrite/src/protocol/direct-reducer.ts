/** Pure shared public-state reducer; clients and snapshots use this same fold.
 * Local UI scroll/menu/composer state belongs to the client, not this projection.
 */
import { nestedPresentation, replace } from './direct-reducer-nested.js';
import { completedFinalText } from './direct-turn-results.js';
import type { WireCommandReceipt, WireEvent, WireMessage, WireSnapshot } from './direct-wire.js';

/** What the user reads for a provider-history edit; the reason names the operation that caused it. */
function historyReplacedMessage(reason: string): string {
  switch (reason) {
    case 'compaction':
      return 'Conversation compacted: earlier messages were replaced by a summary.';
    case 'rewind':
      return 'Conversation rewound to the chosen point.';
    case 'retry_turn':
    case 'retry_tool':
      return 'Conversation history restored to retry.';
    default:
      return `Conversation history replaced (${reason}).`;
  }
}

function timeline(
  state: WireSnapshot,
  entries: NonNullable<WireSnapshot['timeline']>,
  replacesDraftId?: string,
): WireSnapshot['timeline'] {
  if (state.timeline === null) return null;
  let next = [...state.timeline];
  for (const entry of entries) {
    const index = next.findIndex(
      (item) => item.kind === entry.kind && (item.id === entry.id || item.id === replacesDraftId),
    );
    if (index < 0) next.push(entry);
    else
      next = next.flatMap((item, at) =>
        at === index
          ? [entry]
          : item.kind === entry.kind && (item.id === entry.id || item.id === replacesDraftId)
          ? []
          : [item],
      );
  }
  return next;
}
/** Receipt updates keep their original acceptance slot, just like native state. */
function commandReceipts(
  items: readonly WireCommandReceipt[],
  next: WireCommandReceipt,
): readonly WireCommandReceipt[] {
  const id = next.request.commandId;
  return items.some((item) => item.request.commandId === id)
    ? items.map((item) => (item.request.commandId === id ? next : item))
    : [...items, next];
}
function message(items: readonly WireMessage[], next: WireMessage, draftId?: string): readonly WireMessage[] {
  const index = items.findIndex((item) => item.id === next.id || item.id === draftId);
  if (index < 0) return [...items, next];
  return items.flatMap((item, at) =>
    at === index ? [next] : item.id === next.id || item.id === draftId ? [] : [item],
  );
}
function delta(state: WireSnapshot, event: Extract<WireEvent, { type: 'text_delta' }>): WireSnapshot {
  const payload = event.payload;
  const previous = state.messages.find((item) => item.id === payload.messageId);
  const text = (previous?.text ?? '') + payload.delta;
  return {
    ...state,
    timeline: timeline(state, [{ kind: 'message', id: payload.messageId }]),
    messages: message(state.messages, {
      id: payload.messageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      text,
      draft: true,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      modelStep: payload.modelStep,
    }),
  };
}
/** Reject cross-session input; seq only advances on actual durable event references. */
export function reduceWireEvent(state: WireSnapshot, event: WireEvent): WireSnapshot {
  if (event.sessionId !== state.sessionId) throw new Error('Wire event belongs to a different session');
  const next = reducePayload(state, event);
  return event.seq === null ? next : { ...next, seq: Math.max(next.seq ?? 0, event.seq) };
}
function reducePayload(state: WireSnapshot, event: WireEvent): WireSnapshot {
  switch (event.type) {
    case 'snapshot':
      return event.payload.snapshot;
    case 'turn_started':
      return {
        ...state,
        ...(event.payload.admission
          ? {
              admissions: [
                ...state.admissions.filter((item) => item.clientRequestId !== event.payload.admission!.clientRequestId),
                event.payload.admission,
              ],
            }
          : {}),
        messages: event.payload.input.reduce((items, item) => message(items, item), state.messages),
        timeline: timeline(
          state,
          event.payload.input.map((item) => ({ kind: 'message', id: item.id })),
        ),
        ...(event.payload.foreground
          ? {
              status: 'running' as const,
              activeTurnId: event.turnId,
              reasoning: '',
              reasoningIdentity: null,
              lastError: null,
              terminal: null,
            }
          : {}),
      };
    case 'text_delta':
      return delta(state, event);
    case 'reasoning':
      return {
        ...state,
        reasoning: event.payload.text,
        reasoningIdentity: {
          messageId: event.payload.messageId,
          turnId: event.turnId,
          modelStep: event.payload.modelStep,
        },
      };
    case 'reasoning_delta':
      return {
        ...state,
        reasoning: state.reasoning + event.payload.delta,
        reasoningIdentity: event.payload.messageId
          ? { messageId: event.payload.messageId, turnId: event.turnId, modelStep: event.payload.modelStep }
          : null,
      };
    case 'message': {
      const next = {
        ...event.payload.message,
        ...(event.payload.replacesDraftId ? { replacesDraftId: event.payload.replacesDraftId } : {}),
      };
      return {
        ...state,
        timeline: timeline(state, [{ kind: 'message', id: event.payload.message.id }], event.payload.replacesDraftId),
        messages: message(state.messages, next, event.payload.replacesDraftId),
      };
    }
    case 'tool_called':
    case 'tool_started':
      return {
        ...state,
        timeline: timeline(state, [{ kind: 'tool', id: event.payload.tool.executionId }]),
        tools: replace(
          state.tools.map((tool) => ({ ...tool, id: tool.executionId })),
          { ...event.payload.tool, id: event.payload.tool.executionId },
        ).map(({ id: _id, ...tool }) => tool),
      };
    case 'tool_progress':
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.executionId === event.payload.executionId
            ? { ...tool, progress: (tool.progress ?? '') + event.payload.chunk }
            : tool,
        ),
      };
    case 'tool_finished': {
      // Keep the first accepted execution slot even without call/start metadata.
      const next = { ...state, timeline: timeline(state, [{ kind: 'tool', id: event.payload.executionId }]) };
      const known = state.tools.some((tool) => tool.executionId === event.payload.executionId);
      if (!known)
        return {
          ...next,
          unmatchedToolResults: [
            ...(state.unmatchedToolResults ?? []).filter((item) => item.executionId !== event.payload.executionId),
            event.payload,
          ],
          notices: [
            ...state.notices,
            { kind: 'tool_result', message: `Tool result ${event.payload.executionId}: ${event.payload.output}` },
          ],
        };
      return {
        ...next,
        tools: state.tools.map((tool) =>
          tool.executionId === event.payload.executionId
            ? {
                ...tool,
                status: 'completed',
                output: event.payload.output,
                isError: event.payload.isError,
                ...(event.payload.display !== undefined ? { display: event.payload.display } : {}),
                ...(event.payload.content !== undefined ? { content: event.payload.content } : {}),
              }
            : tool,
        ),
      };
    }
    case 'interaction_opened':
      return {
        ...state,
        pendingInteractions: [
          ...state.pendingInteractions.filter((item) => item.requestId !== event.payload.interaction.requestId),
          event.payload.interaction,
        ],
        tasks: state.tasks.map((task) =>
          task.id === event.payload.interaction.taskId ? { ...task, status: 'awaiting_interaction' } : task,
        ),
        ...(!event.payload.interaction.taskId && state.activeTurnId === event.payload.interaction.turnId
          ? { status: 'awaiting_interaction' as const }
          : {}),
      };
    case 'interaction_resolved': {
      const pendingInteractions = state.pendingInteractions.filter(
        (item) => item.requestId !== event.payload.requestId,
      );
      const awaiting = pendingInteractions.some((item) => !item.taskId && item.turnId === state.activeTurnId);
      return {
        ...state,
        pendingInteractions,
        tasks: state.tasks.map((task) =>
          task.id === event.payload.taskId && task.status !== 'cancelling'
            ? {
                ...task,
                status: pendingInteractions.some((item) => item.taskId === task.id)
                  ? 'awaiting_interaction'
                  : 'running',
              }
            : task,
        ),
        ...(state.activeTurnId ? { status: awaiting ? 'awaiting_interaction' : 'running' } : {}),
      };
    }
    case 'background_notice_enqueued':
      return {
        ...state,
        notifications: {
          notices: [...(state.notifications?.notices ?? []), event.payload.notice],
          deliveries: state.notifications?.deliveries ?? [],
        },
      };
    case 'background_notices_delivered':
      return {
        ...state,
        notifications: {
          notices: state.notifications?.notices ?? [],
          deliveries: [...(state.notifications?.deliveries ?? []), event.payload],
        },
      };
    case 'command_started':
    case 'command_finished':
      return { ...state, commands: commandReceipts(state.commands ?? [], event.payload.receipt) };
    // Live argument evidence is not a finalized tool, root output, or replayable state.
    case 'tool_call_streaming_delta':
      return state;
    case 'request_cost_recorded':
      return {
        ...state,
        requestCosts: [
          ...(state.requestCosts ?? []).filter((cost) => cost.record.requestId !== event.payload.record.requestId),
          event.payload,
        ],
      };
    // Lifecycle evidence is a public audit event, not transcript, usage, cost or
    // terminal state. Retain it on the stream; the snapshot has no duplicate field.
    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed':
      return state;
    case 'session_rotated': {
      if (event.payload.logicalSessionId !== state.sessionId)
        throw new Error('Session rotation belongs to a different logical session');
      // Foreground provider context is physically replaced. Task/queue/command/
      // notification owners, goal/context, and accepted cost/request audit survive.
      return {
        ...state,
        backingSessionId: event.payload.backingSessionId,
        model: event.payload.configuration.model,
        configuration: { ...event.payload.configuration },
        status: 'idle' as const,
        activeTurnId: null,
        messages: [],
        tools: [],
        unmatchedToolResults: [],
        reasoning: '',
        reasoningIdentity: null,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        terminal: null,
        timeline: [],
        turnResults: [],
        lastError: null,
        retryEligibility: { turn: false, tool: false },
      };
    }
    case 'budget_opened':
      return {
        ...state,
        pendingBudgets: [
          ...(state.pendingBudgets ?? []).filter((request) => request.requestId !== event.payload.request.requestId),
          event.payload.request,
        ],
      };
    case 'budget_closed':
      return {
        ...state,
        pendingBudgets: (state.pendingBudgets ?? []).filter((request) => request.requestId !== event.payload.requestId),
      };
    case 'budget_observed':
      return {
        ...state,
        budgetObservations: [
          ...(state.budgetObservations ?? []),
          { turnId: event.turnId, evidence: event.payload.evidence },
        ],
      };
    case 'history_replaced':
      return {
        ...state,
        notices: [
          ...state.notices,
          { kind: 'history_replaced', message: historyReplacedMessage(event.payload.reason) },
        ],
      };
    // An accepted response boundary is not an aggregate settled cost or a terminal.
    case 'model_response_completed':
      return state;
    case 'admission':
      return {
        ...state,
        admissions: [
          ...state.admissions.filter((item) => item.clientRequestId !== event.payload.admission.clientRequestId),
          event.payload.admission,
        ],
      };
    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + event.payload.usage.inputTokens,
          outputTokens: state.usage.outputTokens + event.payload.usage.outputTokens,
          cachedInputTokens: state.usage.cachedInputTokens + event.payload.usage.cachedInputTokens,
        },
      };
    case 'status_changed':
      return { ...state, status: event.payload.status };
    case 'turn_ended':
      return {
        ...state,
        pendingBudgets: (state.pendingBudgets ?? []).filter((request) => request.turnId !== event.turnId),
        turnResults: event.turnId
          ? [
              ...(state.turnResults ?? []).filter((result) => result.turnId !== event.turnId),
              {
                turnId: event.turnId,
                ...event.payload,
                messages: state.messages.filter((message) => message.turnId === event.turnId),
                finalText:
                  event.payload.finalText !== undefined
                    ? event.payload.finalText
                    : completedFinalText(
                        event.payload.outcome,
                        state.messages.filter((message) => message.turnId === event.turnId),
                      ),
              },
            ]
          : state.turnResults,
        pendingInteractions: state.pendingInteractions.filter((item) => item.taskId || item.turnId !== event.turnId),
        ...(state.activeTurnId === event.turnId || state.activeTurnId === null
          ? {
              activeTurnId: null,
              status: event.payload.outcome === 'interrupted' ? ('interrupted' as const) : ('idle' as const),
            }
          : {}),
        lastError: event.payload.error ?? state.lastError,
        terminal: event.turnId ? { turnId: event.turnId, ...event.payload } : state.terminal,
        tools: state.tools.map((tool) =>
          tool.turnId === event.turnId && tool.status === 'started' ? { ...tool, status: 'unknown' } : tool,
        ),
      };
    case 'retry_eligibility':
      return { ...state, retryEligibility: event.payload };
    case 'configuration':
      return {
        ...state,
        model: event.payload.model ?? state.model,
        configuration: { ...state.configuration, ...event.payload },
      };
    case 'queue_changed':
      return {
        ...state,
        queue: event.payload.entries,
        queueState: event.payload.state,
        queuePauseReason: event.payload.pauseReason ?? null,
        submissions: event.payload.submissions ?? state.submissions,
        ...(event.payload.admission
          ? {
              admissions: [
                ...state.admissions.filter((item) => item.clientRequestId !== event.payload.admission!.clientRequestId),
                event.payload.admission,
              ],
            }
          : {}),
        messages: (event.payload.messages ?? []).reduce((items, item) => message(items, item), state.messages),
        timeline: timeline(
          state,
          (event.payload.messages ?? []).map((item) => ({ kind: 'message', id: item.id })),
        ),
      };
    case 'task_changed':
      return {
        ...state,
        tasks: replace(state.tasks, event.payload.task),
        ...(event.payload.task.result
          ? { pendingInteractions: state.pendingInteractions.filter((item) => item.taskId !== event.payload.task.id) }
          : {}),
      };
    case 'task_progress':
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === event.payload.taskId
            ? {
                ...task,
                lastActivityAt: event.payload.at,
                progress: (task.progress ?? '') + event.payload.chunk,
                ...(event.payload.kind === 'text' ? { text: (task.text ?? '') + event.payload.chunk } : {}),
              }
            : task,
        ),
      };
    case 'cost':
      return { ...state, cost: event.payload };
    case 'automatic_memory_notice':
      return {
        ...state,
        notices: [
          ...state.notices,
          { kind: 'automatic_memory', message: `${event.payload.command}\n${event.payload.output}` },
        ],
      };
    case 'notice':
      return { ...state, notices: [...state.notices, event.payload] };
    case 'goal':
      return {
        ...state,
        goal: event.payload.goal,
        goalProposal: null,
        goalGeneration: event.payload.generation ?? state.goalGeneration,
      };
    case 'goal_proposed':
      return { ...state, goalProposal: event.payload.goal };
    case 'verification':
      return { ...state, verification: event.payload.verification };
    case 'error':
      return { ...state, lastError: event.payload.error };
    // Presentation only: these DTOs still require actual Session producers. They do
    // not authorize retries, discard public history, or complete a parent turn.
    case 'retrying':
      return {
        ...state,
        notices: [
          ...state.notices,
          {
            kind: 'retrying',
            message: `Retry ${event.payload.toolName ?? 'model'} (${event.payload.attempt}${
              event.payload.maxRetries !== undefined ? `/${event.payload.maxRetries}` : ''
            }) in ${event.payload.delayMs}ms: ${event.payload.error.message}`,
          },
        ],
      };
    case 'compacted':
      return {
        ...state,
        notices: [
          ...state.notices,
          {
            kind: 'compacted',
            message: `Compacted ${event.payload.replaced} items (summary ${event.payload.summaryId}).`,
          },
        ],
      };
    case 'subagent':
      return nestedPresentation(state, event);
  }
}
