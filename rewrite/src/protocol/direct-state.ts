/** Snapshot projection of the actual native facade. Missing later fields are not inferred from private state. */
import type { DirectSessionState, DirectToolDisplay } from '../session/facade-types.js';
import type { DirectDisplayTool, DirectPublicState } from '../session/direct-state.js';
import { DIRECT_PROTOCOL_VERSION, type WireConfiguration, type WireModel, type WireSnapshot } from './direct-wire.js';
import type { DirectContextState } from '../session/direct-context.js';
import { publicContext } from './direct-context.js';
import type { DirectTaskState } from '../session/direct-background-types.js';
import type { DirectQueueState } from '../session/direct-queue-types.js';
import { publicCommandReceipt } from './direct-command-receipts.js';
import { publicRequestCost } from './direct-costs.js';
import { publicBudgetRequest } from './direct-budget.js';
import { publicTurnResults } from './direct-turn-results.js';
import { publicQueue } from './direct-queue.js';
import { publicTask, publicTaskInteraction } from './direct-tasks.js';
import {
  contentText,
  publicContent,
  publicInteraction,
  publicJson,
  publicToolContent,
  publicTerminal,
} from './direct-public.js';

/** The concrete Session read model can report a poisoned writer without an accepted
 * turn_ended. Read its real additive field; never synthesize a durable fact/cursor.
 */
export function runtimeDirectError(state: DirectSessionState & Partial<Pick<DirectPublicState, 'runtimeError'>>) {
  const error = state.runtimeError;
  return error ? { kind: error.kind, message: error.message, retryable: error.retryable } : null;
}
function toolStatus(tool: DirectToolDisplay & Partial<Pick<DirectDisplayTool, 'phase'>>) {
  return tool.phase ?? tool.status;
}
/** Exact public configuration fields; no native intent/profile/runtime graph. */
export function publicWireConfiguration(state: DirectSessionState): WireConfiguration & { readonly model: WireModel } {
  const configuration = state.configuration?.configuration;
  return {
    model: configuration?.model
      ? { provider: configuration.model.provider, model: configuration.model.model }
      : { provider: state.model.provider, model: state.model.model },
    ...(configuration?.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
    ...(configuration?.temperature !== undefined ? { temperature: configuration.temperature } : {}),
  };
}

export function snapshotDirectState(
  state: DirectSessionState & {
    readonly tasks?: readonly DirectTaskState[];
    readonly queue?: DirectQueueState;
    readonly context?: DirectContextState;
  },
  previous?: WireSnapshot,
): WireSnapshot {
  const messages = state.messages.map((item) => {
    const content = publicContent(item.content);
    const { presentation: _presentation, ...known } =
      previous?.messages.find((message) => message.id === item.id) ?? {};
    const draft = state.drafts.find((draft) => draft.id === item.id);
    const correlated = item as typeof item & { readonly turnId?: string; readonly modelStep?: number };
    return {
      ...known,
      ...(item.presentation ? { presentation: structuredClone(item.presentation) } : {}),
      ...(correlated.turnId ? { turnId: correlated.turnId } : {}),
      ...(correlated.modelStep !== undefined ? { modelStep: correlated.modelStep } : {}),
      ...(draft ? { draft: true, turnId: draft.turnId, modelStep: draft.modelStep } : {}),
      id: item.id,
      role: item.role,
      content,
      text: contentText(content),
    };
  });
  const turnResults = publicTurnResults(state, messages);
  // A captured successor state can arrive without the live reset event (for example
  // on reconnect). Its physical header changed, so foreground-only leftovers from
  // the predecessor must not survive either.
  const rotated = previous !== undefined && previous.backingSessionId !== state.backingSessionId;
  return {
    protocolVersion: DIRECT_PROTOCOL_VERSION,
    sessionId: state.id,
    seq: previous?.seq ?? null,
    backingSessionId: state.backingSessionId,
    status: state.status,
    model: { provider: state.model.provider, model: state.model.model },
    configuration: state.configuration
      ? publicWireConfiguration(state)
      : { ...previous?.configuration, model: { provider: state.model.provider, model: state.model.model } },
    activeTurnId: state.status === 'idle' || state.status === 'closed' ? null : state.activeTurnId,
    messages,
    tools: state.tools.map((tool) => {
      const known = previous?.tools.find((item) => item.executionId === tool.executionId);
      return {
        ...known,
        executionId: tool.executionId,
        turnId: tool.turnId,
        toolName: tool.toolName,
        callId: tool.callId,
        ...(tool.parentExecutionId ? { parentExecutionId: tool.parentExecutionId } : {}),
        ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
        ...(tool.display !== undefined ? { display: publicJson(tool.display) } : {}),
        ...(tool.providerOutput ? { content: publicToolContent(tool.providerOutput) } : {}),
        input: publicJson(tool.input),
        status: toolStatus(tool),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
      };
    }),
    unmatchedToolResults: rotated ? [] : previous?.unmatchedToolResults ?? [],
    pendingInteractions: [
      ...new Map(
        [
          ...state.pendingInteractions.map(publicInteraction),
          ...(state.tasks ?? []).flatMap((task) =>
            task.pendingInteractions.map((request) => publicTaskInteraction(request, publicTask(task))),
          ),
        ].map((request) => [request.requestId, request]),
      ).values(),
    ],
    pendingBudgets: state.pendingBudgets.map(publicBudgetRequest),
    budgetObservations: previous?.budgetObservations ?? [],
    turnResults,
    requestCosts: state.requestCosts.map(publicRequestCost),
    commands: state.commands.map(publicCommandReceipt),
    notifications: structuredClone(state.notifications),
    admissions: (state.queue ? state.queue.records.map((record) => record.admission) : state.admissions).map(
      (admission) => ({ ...admission }),
    ),
    usage: { ...state.usage },
    ...(state.lastUsage ? { lastUsage: { ...state.lastUsage } } : {}),
    ...(state.lastSpeed ? { lastSpeed: { ...state.lastSpeed } } : {}),
    reasoning: state.reasoning,
    reasoningIdentity: !rotated && previous?.reasoning === state.reasoning ? previous.reasoningIdentity ?? null : null,
    retryEligibility: rotated
      ? { turn: false, tool: false }
      : previous?.retryEligibility ?? { turn: false, tool: false },
    ...(state.queue
      ? publicQueue(state.queue, turnResults)
      : {
          queue: previous?.queue ?? [],
          queueState: previous?.queueState ?? 'idle',
          queuePauseReason: previous?.queuePauseReason ?? null,
          submissions: previous?.submissions ?? [],
        }),
    tasks:
      state.tasks?.map((task) => ({
        ...previous?.tasks.find((known) => known.id === task.taskId),
        ...publicTask(task),
      })) ??
      previous?.tasks ??
      [],
    cost: previous?.cost ?? null,
    ...(state.context
      ? publicContext(state.context)
      : {
          goal: previous?.goal ?? null,
          goalGeneration: previous?.goalGeneration ?? 0,
          verification: previous?.verification ?? null,
        }),
    goalProposal: previous?.goalProposal ?? null,
    notices: previous?.notices ?? [],
    lastError: runtimeDirectError(state) ?? state.terminal?.error ?? null,
    terminal: state.terminal
      ? {
          turnId: state.terminal.turnId,
          ...publicTerminal(state.terminal),
          finalText: turnResults.find((result) => result.turnId === state.terminal!.turnId)?.finalText ?? null,
        }
      : null,
    timeline: state.timeline
      .filter(
        (entry): entry is typeof entry & { readonly kind: 'message' | 'tool' } =>
          entry.kind === 'message' || entry.kind === 'tool',
      )
      .map(({ kind, id }) => ({ kind, id })),
  };
}
