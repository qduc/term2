/** Public direct-Session projection. Provider history is never retained here. */
import type { TurnId } from '../engine/index.js';
import type { ContentPart, ModelError, ModelRef, Usage } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { DirectMessage, DirectSessionState, DirectToolDisplay } from './facade-types.js';
export type { DirectDraft } from './facade-types.js';
import { isDirectTaskFact, isDirectQueueFact, type Fact } from './facts.js';
import { initialDirectContextState } from './context.js';
import { foldFact } from './fold-fact.js';
import { createDirectQueueState, directQueueSteeredInput } from './queue.js';
import { isDirectCommandFactType, recoverDirectCommands } from './command-receipts.js';
import { isDirectNotificationFactType } from './notifications.js';
import { withNotice } from './input-notice.js';
import { INTERRUPTED_BEFORE_START } from './replay-active-turn.js';
import { withdrawDisplayDraft } from './state-messages.js';

export type DirectDisplayTool = DirectToolDisplay & {
  /** A model call is not evidence that its physical body started. */
  readonly phase: 'called' | 'started' | 'completed' | 'unknown';
  /** Interrupted before its physical start; a cancelled turn drops such rows like legacy. */
  readonly unstarted?: true;
};
type DirectReadMessage = DirectMessage & {
  /** Ephemeral read-model provenance, never a durable fact or wire field. */
  readonly transcriptObservation?: true;
};
/** The shared public read model plus explicit non-durable runtime failure. */
export type DirectPublicState = Omit<DirectSessionState, 'tools' | 'messages'> & {
  readonly messages: readonly DirectReadMessage[];
  readonly tools: readonly DirectDisplayTool[];
  readonly runtimeError: ModelError | null;
};

/** Starts an empty read model; accepted facts, not provider calls, advance it. */
export function initialDirectState(id: string, workspace: Workspace, model: ModelRef): DirectPublicState {
  return {
    id,
    backingSessionId: id,
    workspace,
    model,
    status: 'idle',
    messages: [],
    tools: [],
    pendingInteractions: [],
    admissions: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    activeTurnId: null,
    drafts: [],
    reasoning: '',
    runtimeError: null,
    terminal: null,
    context: initialDirectContextState(),
    tasks: [],
    queue: createDirectQueueState(),
    turnResults: [],
    requestCosts: [],
    commands: [],
    notifications: { notices: [], deliveries: [] },
    pendingBudgets: [],
    timeline: [],
  };
}

/** Identical stable draft identity for live projection and read-only replay. */
export function directDraftId(turnId: TurnId, modelStep?: number): string {
  return modelStep === undefined ? `${turnId}-partial` : `${turnId}-model-${modelStep}-partial`;
}

/** Applies one accepted fact without mutating any previously captured snapshot. */
export function reduceDirectFact(state: DirectPublicState, fact: Fact, seq = 0): DirectPublicState {
  if (isDirectNotificationFactType(fact.type) || isDirectCommandFactType(fact.type))
    return { ...state, ...foldFact({ notifications: state.notifications, commands: state.commands }, fact) };
  const timeline = [...state.timeline];
  const add = (
    kind: import('./facade-types.js').DirectTimelineEntry['kind'],
    id: string,
    turnId?: TurnId,
    modelStep?: number,
  ): void => {
    if (!timeline.some((entry) => entry.kind === kind && entry.id === id))
      timeline.push({
        seq,
        kind,
        id,
        ...(turnId ? { turnId } : {}),
        ...(modelStep === undefined ? {} : { modelStep }),
      });
  };
  if (fact.type === 'transcript_message') add('message', fact.message.id, fact.turnId);
  if (fact.type === 'turn_started' && !fact.silent && fact.display !== false)
    for (const item of fact.input) if (item.type === 'user_message') add('message', item.id, fact.turnId);
  if (fact.type === 'text_delta')
    add('message', directDraftId(fact.turnId, fact.modelStep), fact.turnId, fact.modelStep);
  if (fact.type === 'item' && fact.display !== false) {
    const item = fact.item;
    if (item.type === 'assistant_message' || item.type === 'user_message') {
      const draft = timeline.find(
        (entry) => entry.kind === 'message' && entry.id === directDraftId(fact.turnId, fact.modelStep),
      );
      if (item.type === 'assistant_message' && draft) timeline[timeline.indexOf(draft)] = { ...draft, id: item.id };
      else add('message', item.id, fact.turnId, fact.modelStep);
    }
    if (item.type === 'reasoning') add('reasoning', item.id, fact.turnId, fact.modelStep);
    // A result can be the first accepted display evidence for this execution.
    if ((item.type === 'tool_call' || item.type === 'tool_result') && fact.executionId)
      add('tool', fact.executionId, fact.turnId, fact.modelStep);
  }
  if (fact.type === 'tool_started' || fact.type === 'tool_finished') add('tool', fact.executionId, fact.turnId);
  if (fact.type === 'task_started') add('task', fact.task.taskId, fact.task.parentTurnId);
  const folded = foldFact({ context: state.context, queue: state.queue, tasks: state.tasks }, fact);
  state = { ...state, timeline, context: folded.context };
  if (isDirectTaskFact(fact)) {
    const tasks = folded.tasks;
    const rootRequests = state.pendingInteractions.filter((request) => !('taskId' in request));
    return {
      ...state,
      tasks,
      pendingInteractions: [...rootRequests, ...tasks.flatMap((task) => task.pendingInteractions)],
    };
  }
  if (isDirectQueueFact(fact)) {
    const input = fact.type === 'queue_steered' ? directQueueSteeredInput(state.queue, fact) : [];
    for (const item of input)
      if (item.type === 'user_message')
        add('message', item.id, fact.type === 'queue_steered' ? fact.turnId : undefined);
    const queue = folded.queue;
    return {
      ...state,
      queue,
      timeline,
      admissions: queue.records.map((record) => record.admission),
      messages: [
        ...state.messages,
        ...input.flatMap((item) =>
          messageFor(item).map((message) => ({
            ...message,
            turnId: fact.type === 'queue_steered' ? fact.turnId : undefined,
          })),
        ),
      ],
    };
  }
  switch (fact.type) {
    case 'transcript_message':
      return {
        ...state,
        messages: replaceMessage(state.messages, {
          ...fact.message,
          ...(fact.turnId ? { turnId: fact.turnId } : {}),
          transcriptObservation: true,
        }),
      };
    case 'session_rotated':
      return {
        ...state,
        backingSessionId: fact.sessionId,
        model: fact.configuration.model,
        configuration: { configuration: fact.configuration, intent: fact.intent, profile: fact.profile },
        status: 'idle',
        activeTurnId: null,
        messages: [],
        tools: [],
        drafts: [],
        reasoning: '',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        lastUsage: undefined,
        lastSpeed: undefined,
        codexQuota: undefined,
        terminal: null,
        runtimeError: null,
        timeline: [],
        turnResults: [],
        // Task/queue/command/goal/notification owners and request-cost accounting survive.
      };
    case 'history_replaced': {
      if (fact.retainTranscript) return state;
      const retained = new Set<string>(fact.history.map((item) => item.id));
      const messages = fact.history.flatMap((item) => {
        const known = state.messages.find((message) => message.id === item.id);
        return known ? [known.transcriptObservation ? known : { ...known, ...messageFor(item)[0] }] : [];
      });
      const messageIds = new Set(messages.map((message) => message.id));
      return {
        ...state,
        lastUsage: undefined,
        lastSpeed: undefined,
        messages,
        drafts: state.drafts.filter((draft) => retained.has(draft.id)),
        timeline: state.timeline.filter((entry) => entry.kind !== 'message' || messageIds.has(entry.id)),
      };
    }
    case 'budget_opened':
      return { ...state, pendingBudgets: [...state.pendingBudgets, fact] };
    case 'budget_closed':
      return {
        ...state,
        pendingBudgets: state.pendingBudgets.filter((request) => request.requestId !== fact.requestId),
      };
    case 'request_cost_recorded':
      return {
        ...state,
        requestCosts: [...state.requestCosts.filter((entry) => entry.record.requestId !== fact.record.requestId), fact],
      };
    case 'configuration_changed': {
      const { type: _type, ...configuration } = fact;
      return {
        ...state,
        codexQuota: undefined,
        configuration: structuredClone(configuration),
        model: fact.configuration.model,
        lastUsage: undefined,
        lastSpeed: undefined,
      };
    }
    case 'session_started':
      return { ...state, model: fact.model };
    case 'turn_started':
      return {
        ...state,
        status: 'running',
        activeTurnId: fact.turnId,
        reasoning: '',
        runtimeError: null,
        terminal: null,
        messages: [
          ...state.messages,
          ...(fact.silent || fact.display === false
            ? []
            : (fact.persistentNotice ? withNotice(fact.input, fact.persistentNotice) : fact.input).flatMap((item) =>
                messageFor(item).map((message) => ({ ...message, turnId: fact.turnId })),
              )),
        ],
        admissions:
          fact.submission &&
          !state.admissions.some(
            (admission) =>
              admission.kind !== 'duplicate' &&
              'messageId' in admission &&
              admission.messageId === fact.submission!.messageId,
          )
            ? [...state.admissions, directSubmittedTurn(fact)!.admission]
            : state.admissions,
      };
    case 'text_delta': {
      const modelStep = fact.modelStep ?? 1;
      const id = directDraftId(fact.turnId, fact.modelStep);
      if (fact.withdrawn) return withdrawDisplayDraft(state, id);
      const existing = state.drafts.find((draft) => draft.id === id);
      const draft = { id, turnId: fact.turnId, modelStep, text: (existing?.text ?? '') + fact.delta };
      return {
        ...state,
        drafts: [...state.drafts.filter((entry) => entry.id !== id), draft],
        messages: replaceMessage(state.messages, {
          id,
          role: 'assistant',
          turnId: fact.turnId,
          content: [{ type: 'text', text: draft.text }],
        }),
      };
    }
    case 'item': {
      if (fact.display === false) return state;
      if (fact.item.type === 'tool_call' && fact.executionId) {
        const tool: DirectDisplayTool = {
          executionId: fact.executionId,
          turnId: fact.turnId,
          callId: fact.item.callId,
          toolName: fact.item.toolName,
          input: fact.item.input,
          status: 'unknown',
          phase: 'called',
        };
        return { ...state, tools: replaceTool(state.tools, tool) };
      }
      if (fact.item.type === 'tool_result' && fact.executionId) {
        const result = fact.item;
        return {
          ...state,
          tools: state.tools.map((tool) =>
            tool.executionId !== fact.executionId
              ? tool
              : {
                  ...tool,
                  status: 'completed',
                  phase: 'completed',
                  ...(tool.phase === 'called' && result.output === INTERRUPTED_BEFORE_START
                    ? { unstarted: true as const }
                    : {}),
                  output: result.output,
                  isError: result.isError,
                  ...(result.providerOutput ? { providerOutput: result.providerOutput } : {}),
                },
          ),
        };
      }
      if (fact.item.type === 'reasoning') return { ...state, reasoning: fact.item.summary };
      if (fact.item.type !== 'assistant_message' && fact.item.type !== 'user_message') return state;
      const draftId = directDraftId(fact.turnId, fact.modelStep);
      return {
        ...state,
        drafts:
          fact.item.type === 'assistant_message' ? state.drafts.filter((draft) => draft.id !== draftId) : state.drafts,
        messages: replaceMessage(
          state.messages,
          { ...messageFor(fact.item)[0]!, turnId: fact.turnId },
          fact.item.type === 'assistant_message' ? draftId : undefined,
        ),
      };
    }
    case 'tool_started':
      return {
        ...state,
        tools: replaceTool(state.tools, {
          executionId: fact.executionId,
          turnId: fact.turnId,
          callId: fact.callId,
          toolName: fact.toolName,
          input: fact.input,
          status: 'started',
          phase: 'started',
          ...(fact.parentExecutionId ? { parentExecutionId: fact.parentExecutionId } : {}),
        }),
      };
    case 'tool_finished':
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.executionId !== fact.executionId
            ? tool
            : {
                ...tool,
                status: 'completed',
                phase: 'completed',
                output: fact.result.output,
                isError: fact.result.isError,
                ...(fact.result.providerOutput ? { providerOutput: fact.result.providerOutput } : {}),
                ...(fact.result.display !== undefined ? { display: fact.result.display } : {}),
              },
        ),
      };
    case 'interaction_opened':
      return {
        ...state,
        status: 'awaiting_interaction',
        pendingInteractions: [...state.pendingInteractions, fact.request],
      };
    case 'interaction_closed': {
      const pendingInteractions = state.pendingInteractions.filter((request) => request.requestId !== fact.requestId);
      return {
        ...state,
        pendingInteractions,
        status: pendingInteractions.some((request) => !('taskId' in request))
          ? 'awaiting_interaction'
          : state.activeTurnId
          ? 'running'
          : state.status,
      };
    }
    case 'usage':
      return { ...state, usage: addUsage(state.usage, fact.usage), lastUsage: fact.usage, lastSpeed: fact.speed };
    case 'turn_ended': {
      const dropped = (tool: DirectDisplayTool) =>
        fact.outcome === 'cancelled' && tool.turnId === fact.turnId && tool.unstarted === true;
      const droppedIds = new Set(state.tools.filter(dropped).map((tool) => tool.executionId as string));
      return {
        ...state,
        status: fact.outcome === 'interrupted' ? 'interrupted' : 'idle',
        activeTurnId: null,
        pendingBudgets: state.pendingBudgets.filter((request) => request.turnId !== fact.turnId),
        pendingInteractions: state.pendingInteractions.filter(
          (request) => 'taskId' in request || request.turnId !== fact.turnId,
        ),
        // The dropped rows leave the timeline too, or a client's transcript order stops at the missing tool.
        timeline: droppedIds.size
          ? state.timeline.filter((entry) => entry.kind !== 'tool' || !droppedIds.has(entry.id))
          : state.timeline,
        tools: state.tools
          .filter((tool) => !dropped(tool))
          .map((tool) =>
            tool.turnId === fact.turnId && tool.status === 'started'
              ? { ...tool, status: 'unknown', phase: 'unknown' }
              : tool,
          ),
        terminal: {
          turnId: fact.turnId,
          outcome: fact.outcome,
          ...(fact.error ? { error: fact.error } : {}),
          ...(fact.terminalCause ? { terminalCause: fact.terminalCause } : {}),
          ...(fact.notice ? { notice: fact.notice } : {}),
        },
        turnResults: [
          ...state.turnResults,
          {
            turnId: fact.turnId,
            ...(fact.finalWindow ? { finalWindow: fact.finalWindow } : {}),
            outcome: fact.outcome,
            messages: state.messages.filter((message) => message.turnId === fact.turnId),
            ...(fact.terminalCause ? { terminalCause: fact.terminalCause } : {}),
            ...(fact.notice ? { notice: fact.notice } : {}),
          },
        ],
      };
    }
    default:
      return state;
  }
}

/** Reopening cannot resurrect a live interaction or claim an unobserved effect finished. */
export function interruptedDirectState(state: DirectPublicState): DirectPublicState {
  const unfinished = state.tasks.some((task) => ['running', 'waiting_for_answer', 'cancelling'].includes(task.status));
  const commands = recoverDirectCommands(state.commands).reduce(
    (receipts, fact) => foldFact({ commands: receipts }, fact).commands,
    state.commands,
  );
  if (!state.activeTurnId && !unfinished) return { ...state, commands };
  return {
    ...state,
    commands,
    status: state.status === 'closed' ? 'closed' : 'interrupted',
    activeTurnId: null,
    pendingInteractions: [],
    pendingBudgets: [],
    tasks: state.tasks.map((task) =>
      ['running', 'waiting_for_answer', 'cancelling'].includes(task.status)
        ? {
            ...task,
            status: 'interrupted',
            pendingInteractions: [],
            result: { kind: 'interrupted', reason: 'outcome_unobserved' },
          }
        : task,
    ),
    tools: state.tools.map((tool) =>
      tool.status === 'started' ? { ...tool, status: 'unknown', phase: 'unknown' } : tool,
    ),
  };
}

function messageFor(item: {
  readonly type: string;
  readonly id: string;
  readonly content?: readonly ContentPart[];
}): DirectMessage[] {
  if ((item.type !== 'user_message' && item.type !== 'assistant_message') || !item.content) return [];
  return [{ id: item.id, role: item.type === 'user_message' ? 'user' : 'assistant', content: item.content }];
}

function replaceMessage(
  messages: readonly DirectReadMessage[],
  message: DirectReadMessage,
  replaces = message.id,
): readonly DirectReadMessage[] {
  const index = messages.findIndex((entry) => entry.id === replaces || entry.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.flatMap((entry, offset) =>
    offset === index ? [message] : entry.id === replaces || entry.id === message.id ? [] : [entry],
  );
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

function replaceTool(tools: readonly DirectDisplayTool[], tool: DirectDisplayTool): readonly DirectDisplayTool[] {
  const existing = tools.findIndex((entry) => entry.executionId === tool.executionId);
  return existing < 0 ? [...tools, tool] : tools.map((entry, index) => (index === existing ? tool : entry));
}

/** Reads exactly the durable user item named by turn_started submission correlation. */
export function directSubmittedTurn(fact: Extract<Fact, { readonly type: 'turn_started' }>) {
  if (!fact.submission) return null;
  const submission = fact.submission;
  const item = fact.input.find((entry) => entry.type === 'user_message' && entry.id === submission.messageId);
  if (!submission.clientRequestId?.trim() || item?.type !== 'user_message') {
    throw new Error('invalid direct turn submission correlation');
  }
  return {
    request: {
      clientRequestId: submission.clientRequestId,
      content: item.content,
      ...(submission.origin ? { origin: submission.origin } : {}),
    },
    admission: {
      kind: 'started',
      clientRequestId: submission.clientRequestId,
      messageId: submission.messageId,
      turnId: fact.turnId,
    } as const,
  };
}
