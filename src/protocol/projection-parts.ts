import type { DirectSessionRotationFact } from '../session/session-rotation.js';
import type { Fact } from '../session/facts.js';
import { directDraftId } from '../session/state.js';
import type {
  WireConfiguration,
  WireEvent,
  WireEventPayloads,
  WireEventType,
  WireModel,
  WireSnapshot,
} from './wire.js';
import { publicJson, publicMessage, publicToolContent } from './public.js';

type EventFactory = <K extends WireEventType>(
  type: K,
  payload: WireEventPayloads[K],
  seq: number | null,
  turnId: string | null,
) => WireEvent;
type ToolIdentity = (executionId: string) => Partial<WireEventPayloads['tool_finished']>;

/** Public configuration copied from an accepted configuration or rotation; never intent/profile. */
export function rotationConfiguration(
  fact: DirectSessionRotationFact | Extract<Fact, { type: 'configuration_changed' }>,
): WireConfiguration & { readonly model: WireModel } {
  return {
    model: { provider: fact.configuration.model.provider, model: fact.configuration.model.model },
    ...(fact.configuration.reasoning !== undefined ? { reasoning: fact.configuration.reasoning } : {}),
    ...(fact.configuration.temperature !== undefined ? { temperature: fact.configuration.temperature } : {}),
  };
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

/** Withdrawal settles display only; it is not an accepted model answer. */
export function projectTextDelta(
  fact: Extract<Fact, { type: 'text_delta' }>,
  seq: number,
  state: WireSnapshot,
  event: EventFactory,
): readonly WireEvent[] {
  const messageId = directDraftId(fact.turnId, fact.modelStep);
  if (fact.withdrawn) {
    const message = state.messages.find((item) => item.id === messageId);
    return message
      ? [
          event(
            'message',
            {
              message: {
                ...message,
                draft: false,
                presentation: { ...message.presentation, withdrawn: true },
              },
            },
            seq,
            fact.turnId,
          ),
        ]
      : [];
  }
  return [event('text_delta', { delta: fact.delta, modelStep: fact.modelStep ?? 1, messageId }, seq, fact.turnId)];
}
