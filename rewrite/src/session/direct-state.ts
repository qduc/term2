/** Public direct-Session projection. Provider history is never retained here. */
import type { TurnId } from '../engine/index.js';
import type { ContentPart, ModelError, ModelRef, Usage } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { DirectMessage, DirectSessionState, DirectToolDisplay } from './facade-types.js';
export type { DirectDraft } from './facade-types.js';
import type { Fact } from './facts.js';

export type DirectDisplayTool = DirectToolDisplay & {
  /** A model call is not evidence that its physical body started. */
  readonly phase: 'called' | 'started' | 'completed' | 'unknown';
};
/** The shared public read model plus explicit non-durable runtime failure. */
export type DirectPublicState = Omit<DirectSessionState, 'tools'> & {
  readonly tools: readonly DirectDisplayTool[];
  readonly runtimeError: ModelError | null;
};

/** Starts an empty read model; accepted facts, not provider calls, advance it. */
export function initialDirectState(id: string, workspace: Workspace, model: ModelRef): DirectPublicState {
  return {
    id,
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
  };
}

/** Identical stable draft identity for live projection and read-only replay. */
export function directDraftId(turnId: TurnId, modelStep?: number): string {
  return modelStep === undefined ? `${turnId}-partial` : `${turnId}-model-${modelStep}-partial`;
}

/** Applies one accepted fact without mutating any previously captured snapshot. */
export function reduceDirectFact(state: DirectPublicState, fact: Fact): DirectPublicState {
  switch (fact.type) {
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
        messages: [...state.messages, ...fact.input.flatMap(messageFor)],
        admissions: fact.submission ? [...state.admissions, directSubmittedTurn(fact)!.admission] : state.admissions,
      };
    case 'text_delta': {
      const modelStep = fact.modelStep ?? 1;
      const id = directDraftId(fact.turnId, fact.modelStep);
      const existing = state.drafts.find((draft) => draft.id === id);
      const draft = { id, turnId: fact.turnId, modelStep, text: (existing?.text ?? '') + fact.delta };
      return {
        ...state,
        drafts: [...state.drafts.filter((entry) => entry.id !== id), draft],
        messages: replaceMessage(state.messages, {
          id,
          role: 'assistant',
          content: [{ type: 'text', text: draft.text }],
        }),
      };
    }
    case 'item': {
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
          messageFor(fact.item)[0]!,
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
        status: pendingInteractions.length ? 'awaiting_interaction' : state.activeTurnId ? 'running' : state.status,
      };
    }
    case 'usage':
      return { ...state, usage: addUsage(state.usage, fact.usage) };
    case 'turn_ended':
      return {
        ...state,
        status: fact.outcome === 'interrupted' ? 'interrupted' : 'idle',
        activeTurnId: null,
        pendingInteractions: state.pendingInteractions.filter((request) => request.turnId !== fact.turnId),
        tools: state.tools.map((tool) =>
          tool.turnId === fact.turnId && tool.status === 'started'
            ? { ...tool, status: 'unknown', phase: 'unknown' }
            : tool,
        ),
        terminal: { turnId: fact.turnId, outcome: fact.outcome, ...(fact.error ? { error: fact.error } : {}) },
      };
  }
}

/** Reopening cannot resurrect a live interaction or claim an unobserved effect finished. */
export function interruptedDirectState(state: DirectPublicState): DirectPublicState {
  if (!state.activeTurnId) return state;
  return {
    ...state,
    status: 'interrupted',
    activeTurnId: null,
    pendingInteractions: [],
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
  messages: readonly DirectMessage[],
  message: DirectMessage,
  replaces = message.id,
): readonly DirectMessage[] {
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
