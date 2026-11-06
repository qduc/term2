import type { DirectSessionRotationFact } from '../session/session-rotation.js';
import type { Fact } from '../session/facts.js';
import { directDraftId } from '../session/state.js';
import type { DirectProjection } from './projection.js';
import type {
  WireBranchSnapshot,
  WireConfiguration,
  WireEvent,
  WireEventPayloads,
  WireEventType,
  WireModel,
  WireSnapshot,
} from './wire.js';
import { publicJson, publicMessage, publicToolContent } from './public.js';

type Branch = {
  readonly projection: DirectProjection;
  readonly taskId: string;
  readonly turnId: string;
  acceptedSeq: number;
  hasAcceptedUsage: boolean;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
  readonly role?: string;
};
type EventFactory = <K extends WireEventType>(
  type: K,
  payload: WireEventPayloads[K],
  seq: number | null,
  turnId: string | null,
) => WireEvent;
type ToolIdentity = (executionId: string) => Partial<WireEventPayloads['tool_finished']>;

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
  branches: ReadonlyMap<string, Branch>,
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

export function projectItem(
  fact: Extract<Fact, { type: 'item' }>,
  seq: number,
  event: EventFactory,
  toolIdentity: ToolIdentity,
): readonly WireEvent[] {
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
          ...toolIdentity(executionId),
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
