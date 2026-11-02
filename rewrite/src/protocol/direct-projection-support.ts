/** Pure helpers for accepted-fact projection and branch snapshot presentation. */
import type { DirectSessionRotationFact } from '../session/direct-session-rotation.js';
import { directDraftId } from '../session/direct-state.js';
import type { Fact } from '../session/facts.js';
import { publicJson, publicMessage, publicToolContent } from './direct-public.js';
import type {
  WireBranchSnapshot,
  WireConfiguration,
  WireEvent,
  WireEventPayloads,
  WireEventType,
  WireModel,
  WireSnapshot,
} from './direct-wire.js';

type BranchSnapshotSource = {
  readonly projection: { readonly snapshot: WireSnapshot };
  readonly taskId: string;
  readonly turnId: string;
  readonly acceptedSeq: number;
  readonly hasAcceptedUsage: boolean;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
};

/** Public configuration copied from the accepted rotation header; never intent/profile. */
export function rotationConfiguration(
  fact: DirectSessionRotationFact,
): WireConfiguration & { readonly model: WireModel } {
  return {
    model: { provider: fact.configuration.model.provider, model: fact.configuration.model.model },
    ...(fact.configuration.reasoning !== undefined ? { reasoning: fact.configuration.reasoning } : {}),
    ...(fact.configuration.temperature !== undefined ? { temperature: fact.configuration.temperature } : {}),
  };
}

export function branchSnapshots(
  branches: ReadonlyMap<string, BranchSnapshotSource>,
  root: WireSnapshot,
): readonly WireBranchSnapshot[] {
  return [...branches].map(([branchId, branch]) => {
    const child = branch.projection.snapshot;
    return {
      branchId,
      taskId: branch.taskId,
      turnId: branch.turnId,
      ...(branch.parentTurnId !== undefined ? { parentTurnId: branch.parentTurnId } : {}),
      ...(branch.rootTurnId !== undefined ? { rootTurnId: branch.rootTurnId } : {}),
      acceptedSeq: branch.acceptedSeq,
      messages: child.messages,
      tools: child.tools,
      unmatchedToolResults: child.unmatchedToolResults ?? [],
      timeline: child.timeline,
      pendingInteractions: root.pendingInteractions.filter(
        (request) => request.taskId === branch.taskId && request.turnId === branch.turnId,
      ),
      pendingBudgets: child.pendingBudgets ?? [],
      turnResults: child.turnResults ?? [],
      usage: branch.hasAcceptedUsage ? child.usage : null,
      reasoning: child.reasoningIdentity ? child.reasoning : null,
      reasoningIdentity: child.reasoningIdentity ?? null,
      terminal: child.terminal,
      notices: child.notices,
      requestCosts: (root.requestCosts ?? []).filter((cost) => cost.turnId === branch.turnId),
      queue: null,
    };
  });
}

export function toolIdentity(state: WireSnapshot, executionId: string) {
  const tool = state.tools.find((tool) => tool.executionId === executionId);
  return tool
    ? {
        toolName: tool.toolName,
        input: tool.input,
        ...(tool.callId ? { callId: tool.callId } : {}),
        ...(tool.parentExecutionId ? { parentExecutionId: tool.parentExecutionId } : {}),
      }
    : {};
}

export function itemEvents(
  state: WireSnapshot,
  fact: Extract<Fact, { type: 'item' }>,
  seq: number,
): readonly WireEvent[] {
  const event = <K extends WireEventType>(
    type: K,
    payload: WireEventPayloads[K],
    seq: number | null,
    turnId: string | null,
  ): WireEvent => ({ sessionId: state.sessionId, seq, occurredAt: null, turnId, type, payload } as WireEvent);
  if (fact.display === false) return [];
  const { item, executionId, turnId } = fact;
  if (item.type === 'tool_call') {
    if (!executionId) throw new Error('Tool call fact has no execution identity');
    return [
      event(
        'tool_called',
        {
          tool: {
            executionId,
            turnId,
            callId: item.callId,
            toolName: item.toolName,
            input: publicJson(item.input),
            status: 'called',
          },
        },
        seq,
        turnId,
      ),
    ];
  }
  if (item.type === 'tool_result') {
    if (!executionId) throw new Error('Tool result fact has no execution identity');
    // The provider-facing result is a separate accepted fact. Upsert by occurrence
    // instead of suppressing it using current capture state during historical replay.
    return [
      event(
        'tool_finished',
        {
          executionId,
          ...toolIdentity(state, executionId),
          output: item.output,
          isError: item.isError,
          ...(item.providerOutput ? { content: publicToolContent(item.providerOutput) } : {}),
        },
        seq,
        turnId,
      ),
    ];
  }
  if (item.type === 'reasoning')
    return [
      event('reasoning', { text: item.summary, messageId: item.id, modelStep: fact.modelStep ?? null }, seq, turnId),
    ];
  const message = publicMessage(item, turnId, fact.modelStep, executionId);
  if (!message) return [];
  if (item.type !== 'assistant_message') return [event('message', { message }, seq, turnId)];
  return [event('message', { message, replacesDraftId: directDraftId(turnId, fact.modelStep) }, seq, turnId)];
}
