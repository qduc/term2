/** Pure shared public-state reducer; clients and snapshots use this same fold.
 * Local UI scroll/menu/composer state belongs to the client, not this projection.
 */
import { historyReplacedMessage, nestedPresentation, replace, withToolTracking } from './reducer-nested.js';
import { completedFinalText } from './final-text.js';
import {
  appendedNotice,
  COMPACTING,
  COMPACTION_NOTICE,
  compactionOutcome,
  ENDS_RETRY,
  retrying,
} from './reducer-notices.js';
import type { WireEvent, WireSnapshot, WireTurnResult } from './wire-types.js';
import { commandReceipts, delta, message, timeline, withNotice } from './transcript.js';
import { reduceBranch, withRootShares } from './branch-fold.js';
import { withAnchorsMoved, withoutLiveReasoning, withReasoningBlock, withTurnUsage } from './turn-detail.js';
import { reduceApprovalReview, withoutReview } from './review.js';

/** What a host supplies to the fold. Every field is optional; the fold has a plain default for each. */
export type WireFoldOptions = {
  /** The label of a subagent's newest tool call, as the host's tool rows draw it. Default: the tool's name. */
  readonly formatToolLabel?: (toolName: string, input: unknown) => string;
};

function replaceTool(tools: WireSnapshot['tools'], next: WireSnapshot['tools'][number]): WireSnapshot['tools'] {
  const index = tools.findIndex((tool) => tool.executionId === next.executionId);
  return index < 0 ? [...tools, next] : tools.map((tool, at) => (at === index ? next : tool));
}

/** Reject cross-session input; seq only advances on actual durable event references. */
/** A retry continues from the most recently ended turn; that turn's failure or stop is no longer the outcome. */
function markLastRetried(results: readonly WireTurnResult[]): readonly WireTurnResult[] {
  const last = results.at(-1);
  return last && !last.retried ? [...results.slice(0, -1), { ...last, retried: true }] : results;
}

export function reduceWireEvent(state: WireSnapshot, event: WireEvent, options: WireFoldOptions = {}): WireSnapshot {
  if (event.sessionId !== state.sessionId) throw new Error('Wire event belongs to a different session');
  const reduced = withRootShares(state, reducePayload(state, event, options));
  const next = reduced.retry && ENDS_RETRY.has(event.type) ? { ...reduced, retry: undefined } : reduced;
  return event.seq === null ? next : { ...next, seq: Math.max(next.seq ?? 0, event.seq) };
}
function reducePayload(state: WireSnapshot, event: WireEvent, options: WireFoldOptions): WireSnapshot {
  switch (event.type) {
    case 'snapshot':
      return event.payload.snapshot;
    case 'turn_started':
      return {
        ...(event.payload.foreground ? withoutLiveReasoning(state) : state),
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
              thinking: false,
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
        ...withReasoningBlock(withoutLiveReasoning(state), event),
        reasoning: event.payload.text,
        reasoningIdentity: {
          messageId: event.payload.messageId,
          turnId: event.turnId,
          modelStep: event.payload.modelStep,
        },
      };
    case 'codex_quota':
      return {
        ...state,
        codexQuota: event.payload.quota ?? undefined,
        ...(event.payload.fiveHourQuota !== undefined
          ? { codexFiveHourQuota: event.payload.fiveHourQuota ?? undefined }
          : {}),
      };
    case 'reasoning_started':
      return { ...state, thinking: true };
    case 'reasoning_delta':
      return {
        ...state,
        liveReasoning: (state.liveReasoning ?? '') + event.payload.delta,
        thinking: true,
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
      const moved = withAnchorsMoved(state, event.payload.replacesDraftId, event.payload.message.id);
      return {
        ...moved,
        timeline: timeline(state, [{ kind: 'message', id: event.payload.message.id }], event.payload.replacesDraftId),
        messages: message(state.messages, next, event.payload.replacesDraftId),
      };
    }
    case 'tool_called':
    case 'tool_started':
      return {
        ...state,
        thinking: false,
        timeline: timeline(state, [{ kind: 'tool', id: event.payload.tool.executionId }]),
        // Replaced in place by execution: untouched tools keep their identity, so clients can reuse their rows.
        tools: replaceTool(state.tools, event.payload.tool),
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
            appendedNotice(state, 'tool_result', `Tool result ${event.payload.executionId}: ${event.payload.output}`),
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
    case 'approval_review':
      return reduceApprovalReview(state, event.payload);
    case 'interaction_opened':
      return {
        ...withoutReview(state, event.payload.interaction.requestId),
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
        ...withoutReview(state, event.payload.requestId),
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
    // Lifecycle evidence is otherwise a public audit event. An automatic compaction also shows legacy's
    // live lines (conversation-event-handler.ts): the started line is replaced by its outcome.
    case 'compaction_started':
      return event.payload.trigger === 'automatic' ? withNotice(state, COMPACTION_NOTICE, COMPACTING) : state;
    case 'compaction_completed':
    case 'compaction_failed':
      return compactionOutcome(state, event);
    case 'session_rotated': {
      if (event.payload.logicalSessionId !== state.sessionId)
        throw new Error('Session rotation belongs to a different logical session');
      // Foreground provider context is physically replaced. Task/queue/command/
      // notification owners, goal/context, and accepted cost/request audit survive.
      const { reasoningBlocks: _blocks, turnUsage: _usage, ...kept } = withoutLiveReasoning(state);
      return {
        ...kept,
        backingSessionId: event.payload.backingSessionId,
        model: event.payload.configuration.model,
        configuration: { ...event.payload.configuration },
        status: 'idle' as const,
        activeTurnId: null,
        messages: [],
        tools: [],
        unmatchedToolResults: [],
        reasoning: '',
        thinking: false,
        reasoningIdentity: null,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        lastUsage: undefined,
        lastSpeed: undefined,
        codexQuota: undefined,
        codexFiveHourQuota: undefined,
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
        ...withNotice(state, 'history_replaced', historyReplacedMessage(event.payload.reason)),
        ...(event.payload.retainTranscript ? {} : { lastUsage: undefined, lastSpeed: undefined }),
        ...(event.payload.reason === 'retry_turn' || event.payload.reason === 'retry_tool'
          ? { turnResults: markLastRetried(state.turnResults ?? []) }
          : {}),
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
        ...withTurnUsage(state, event),
        lastUsage: event.payload.usage,
        lastSpeed: event.payload.speed,
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
        ...withoutLiveReasoning(state),
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
              thinking: false,
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
        codexQuota: undefined,
        codexFiveHourQuota: undefined,
        model: event.payload.model ?? state.model,
        lastUsage: undefined,
        lastSpeed: undefined,
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
    case 'task_changed': {
      const task = withToolTracking(state, event.payload.change, event.payload.task);
      return {
        ...state,
        tasks: replace(state.tasks, task),
        ...(event.payload.task.result
          ? { pendingInteractions: state.pendingInteractions.filter((item) => item.taskId !== event.payload.task.id) }
          : {}),
      };
    }
    case 'task_progress':
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === event.payload.taskId
            ? {
                ...task,
                lastActivityAt: event.payload.at,
                ...(event.payload.observation ? { lastObservation: event.payload.observation } : {}),
                progress: (task.progress ?? '') + event.payload.chunk,
                ...(event.payload.kind === 'text' ? { text: (task.text ?? '') + event.payload.chunk } : {}),
              }
            : task,
        ),
      };
    case 'cost':
      return { ...state, cost: event.payload };
    case 'automatic_memory_notice':
      return withNotice(state, 'automatic_memory', `${event.payload.command}\n${event.payload.output}`);
    case 'notice':
      return withNotice(state, event.payload.kind, event.payload.message);
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
      return retrying(state, event);
    case 'compacted':
      return withNotice(
        state,
        'compacted',
        `Compacted ${event.payload.replaced} items (summary ${event.payload.summaryId}).`,
      );
    case 'subagent':
      return reduceBranch(
        nestedPresentation(state, event, options.formatToolLabel ?? ((toolName) => toolName)),
        event,
        (branch, child) => reduceWireEvent(branch, child, options),
      );
  }
}
