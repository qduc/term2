/** Snapshot projection of the actual native facade. Missing later fields are not inferred from private state. */
import type { DirectSessionState, DirectToolDisplay } from '../session/facade-types.js';
import type { DirectDisplayTool, DirectPublicState } from '../session/state.js';
import { isSubscriptionProvider } from '../model/cost/subscription-providers.js';
import {
  DIRECT_PROTOCOL_VERSION,
  type WireConfiguration,
  type WireEvent,
  type WireModel,
  type WireSnapshot,
} from './wire.js';
import type { DirectContextState } from '../session/context.js';
import { publicContext } from './context.js';
import type { DirectTaskState } from '../session/background-types.js';
import type { DirectQueueState } from '../session/queue-types.js';
import { publicCommandReceipt } from './command-receipts.js';
import { publicRequestCost } from './costs.js';
import { publicBudgetRequest } from './budget.js';
import { publicTurnResults } from './turn-results.js';
import { publicQueue } from './queue.js';
import { publicTask, publicTaskInteraction } from './tasks.js';
import {
  contentText,
  publicContent,
  publicInteraction,
  publicJson,
  publicToolContent,
  publicTerminal,
} from './public.js';

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
function publicWireConfiguration(state: DirectSessionState): WireConfiguration & { readonly model: WireModel } {
  const configuration = state.configuration?.configuration;
  return {
    model: configuration?.model
      ? { provider: configuration.model.provider, model: configuration.model.model }
      : { provider: state.model.provider, model: state.model.model },
    ...(configuration?.reasoning !== undefined ? { reasoning: configuration.reasoning } : {}),
    ...(configuration?.temperature !== undefined ? { temperature: configuration.temperature } : {}),
  };
}

/** First element per key, matching Array.find for unique-or-duplicate keys. */
function firstById<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (!byId.has(id)) byId.set(id, item);
  }
  return byId;
}

/**
 * Per-turn detail Session does not keep, carried from the previous snapshot: reasoning summaries while Session's
 * timeline still has them (a rewind or compaction drops the rest), each turn's usage while the turn is still
 * known, and live reasoning. A rotation starts all three afresh.
 */
function turnDetail(
  state: DirectSessionState,
  previous: WireSnapshot | undefined,
  rotated: boolean,
  turnResults: readonly { readonly turnId: string }[],
): Pick<WireSnapshot, 'reasoningBlocks' | 'liveReasoning' | 'turnUsage'> {
  if (!previous || rotated) return {};
  const reasoningIds = new Set(state.timeline.filter((entry) => entry.kind === 'reasoning').map((entry) => entry.id));
  const turnIds = new Set([
    ...turnResults.map((result) => result.turnId),
    ...state.timeline.flatMap((entry) => (entry.turnId ? [entry.turnId] : [])),
  ]);
  // Session's timeline keeps reasoning entries through a rewind, so a block also needs its turn's messages.
  const turnsWithMessages = new Set(
    state.messages.flatMap((message) => {
      const turnId = (message as { readonly turnId?: string }).turnId;
      return turnId ? [turnId] : [];
    }),
  );
  const reasoningBlocks = previous.reasoningBlocks?.filter(
    (block) => reasoningIds.has(block.messageId) && block.turnId !== null && turnsWithMessages.has(block.turnId),
  );
  const turnUsage = previous.turnUsage?.filter((entry) => turnIds.has(entry.turnId));
  return {
    ...(reasoningBlocks?.length ? { reasoningBlocks } : {}),
    ...(previous.liveReasoning !== undefined ? { liveReasoning: previous.liveReasoning } : {}),
    ...(turnUsage?.length ? { turnUsage } : {}),
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
  // Lookups are by id once per snapshot; a find per item made every snapshot quadratic in history.
  const previousMessages = firstById(previous?.messages ?? [], (message) => message.id);
  const previousTools = firstById(previous?.tools ?? [], (tool) => tool.executionId);
  const previousTasks = firstById(previous?.tasks ?? [], (task) => task.id);
  const drafts = firstById(state.drafts, (draft) => draft.id);
  const messages = state.messages.map((item) => {
    const content = publicContent(item.content);
    const { presentation: _presentation, ...known } = previousMessages.get(item.id) ?? {};
    const draft = drafts.get(item.id);
    const correlated = item as typeof item & { readonly turnId?: string; readonly modelStep?: number };
    return {
      ...known,
      ...(item.presentation ? { presentation: structuredClone(item.presentation) } : {}),
      ...(correlated.turnId ? { turnId: correlated.turnId } : {}),
      ...(correlated.modelStep !== undefined ? { modelStep: correlated.modelStep } : {}),
      ...(item.presentation?.withdrawn === true
        ? { draft: false }
        : draft
        ? { draft: true, turnId: draft.turnId, modelStep: draft.modelStep }
        : {}),
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
      const known = previousTools.get(tool.executionId);
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
    ...(state.codexQuota ? { codexQuota: { ...state.codexQuota } } : {}),
    ...(state.codexFiveHourQuota ? { codexFiveHourQuota: { ...state.codexFiveHourQuota } } : {}),
    reasoning: state.reasoning,
    reasoningIdentity: !rotated && previous?.reasoning === state.reasoning ? previous.reasoningIdentity ?? null : null,
    ...turnDetail(state, previous, rotated, turnResults),
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
        ...previousTasks.get(task.taskId),
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
    ...(previous?.retry ? { retry: previous.retry } : {}),
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

type QuotaWindow = { readonly usedPercent: number; readonly resetAt: number };

/** A session's subscription allowance, as one read-only view of its snapshot. */
export type SubscriptionQuotaView = {
  readonly provider: string;
  /** Per-request cost is not the meter for this provider: a plan allowance is. */
  readonly subscription: boolean;
  /** The provider's own last observation; null until a request reports one, and after a model change. */
  readonly windows: { readonly fiveHour: QuotaWindow | null; readonly weekly: QuotaWindow | null };
};

/**
 * For clients the wire does not reach: the Codex quota windows are live-only Session state
 * (`codex_quota`), not an agent-wire v2 change, so a gateway client reads them on demand.
 */
export function subscriptionQuotaView(snapshot: WireSnapshot): SubscriptionQuotaView {
  const window = (quota: WireSnapshot['codexQuota']) =>
    quota ? { usedPercent: quota.usedPercent, resetAt: quota.resetAt } : null;
  return {
    provider: snapshot.model.provider,
    subscription: isSubscriptionProvider(snapshot.model.provider),
    windows: { fiveHour: window(snapshot.codexFiveHourQuota), weekly: window(snapshot.codexQuota) },
  };
}

/** A snapshot as a live event: what a client folds to install a cut. It is not an accepted fact. */
export function snapshotEvent(snapshot: WireSnapshot): WireEvent {
  return {
    sessionId: snapshot.sessionId,
    seq: null,
    occurredAt: null,
    turnId: null,
    type: 'snapshot',
    payload: { snapshot },
  };
}
