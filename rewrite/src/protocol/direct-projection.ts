/** One translation from accepted direct Session updates to wire events.
 * Session alone commits/answers; this class only maintains the public read model.
 */
import type { DirectSessionState, DirectSessionUpdate } from '../session/facade-types.js';
import { directDraftId } from '../session/direct-state.js';
import type { Fact } from '../session/facts.js';
import type { WireEvent, WireEventPayloads, WireEventType, WireSnapshot } from './direct-wire.js';
import { publicInteraction, publicJson, publicMessage, publicToolContent } from './direct-public.js';
import { snapshotDirectState } from './direct-state.js';
import { reduceWireEvent } from './direct-reducer.js';

type FactUpdate = Extract<DirectSessionUpdate, { type: 'fact' }>;
export class DirectProjection {
  #state: WireSnapshot;
  constructor(state: DirectSessionState, seq: number | null = null) { this.#state = { ...snapshotDirectState(state), seq }; }
  get snapshot(): WireSnapshot { return this.#state; }

  /** Updates arrive once in Session publication order; never called from a tool body. */
  update(update: DirectSessionUpdate): readonly WireEvent[] {
    let events: readonly WireEvent[];
    if (update.type === 'state') {
      const snapshot = snapshotDirectState(update.state, this.#state);
      events = [this.#event('snapshot', { snapshot }, null, null)];
    } else if (update.type === 'transient') {
      events = update.event.type === 'reasoning_delta'
        ? [this.#event('reasoning_delta', { delta: update.event.delta, modelStep: null, messageId: null }, null, this.#state.activeTurnId)]
        : [this.#event('tool_progress', { executionId: update.event.executionId, chunk: update.event.chunk }, null,
          this.#state.tools.find(tool => tool.executionId === update.event.executionId)?.turnId ?? null)];
    } else {
      events = this.#fact(update);
    }
    for (const event of events) this.#state = reduceWireEvent(this.#state, event);
    if (update.type === 'fact') this.#state = { ...this.#state, seq: update.seq };
    return events;
  }
  #event<K extends WireEventType>(type: K, payload: WireEventPayloads[K], seq: number | null, turnId: string | null): WireEvent {
    return { sessionId: this.#state.sessionId, seq, turnId, type, payload } as WireEvent;
  }
  #fact({ fact, seq }: FactUpdate): readonly WireEvent[] {
    const turnId = 'turnId' in fact ? fact.turnId : null;
    switch (fact.type) {
      case 'session_started': return [this.#event('configuration', { model: fact.model, ...(fact.reasoning ? { reasoning: fact.reasoning } : {}) }, seq, null)];
      case 'turn_started': return [
        this.#event('turn_started', { foreground: true,
          ...(fact.submission ? { admission: { kind: 'started' as const, clientRequestId: fact.submission.clientRequestId, messageId: fact.submission.messageId, turnId: fact.turnId } } : {}),
          input: fact.input.flatMap(item => { const message = publicMessage(item, fact.turnId); return message ? [message] : []; }),
        }, seq, turnId),
      ];
      case 'text_delta': {
        const step = fact.modelStep ?? 1;
        return [this.#event('text_delta', { delta: fact.delta, modelStep: step, messageId: directDraftId(fact.turnId, fact.modelStep) }, seq, turnId)];
      }
      case 'item': return this.#item(fact, seq);
      case 'tool_started': return [this.#event('tool_started', { tool: {
        executionId: fact.executionId, turnId: fact.turnId, callId: fact.callId, toolName: fact.toolName,
        input: publicJson(fact.input), status: 'started', ...(fact.parentExecutionId ? { parentExecutionId: fact.parentExecutionId } : {}),
      } }, seq, turnId)];
      case 'tool_finished': return [this.#event('tool_finished', {
        executionId: fact.executionId, output: fact.result.output, isError: fact.result.isError,
        ...(fact.result.display !== undefined ? { display: publicJson(fact.result.display) } : {}),
        ...(fact.result.providerOutput ? { content: publicToolContent(fact.result.providerOutput) } : {}),
      }, seq, turnId)];
      case 'interaction_opened': return [this.#event('interaction_opened', { interaction: publicInteraction(fact.request) }, seq, turnId)];
      case 'interaction_closed': return [this.#event('interaction_resolved', { requestId: fact.requestId, resolution: fact.resolution }, seq, turnId)];
      case 'usage': return [this.#event('usage', { usage: fact.usage }, seq, turnId)];
      case 'turn_ended': return [this.#event('turn_ended', {
        outcome: fact.outcome, ...(fact.error ? { error: { kind: fact.error.kind, message: fact.error.message, retryable: fact.error.retryable } } : {}),
      }, seq, turnId)];
    }
  }
  #item(fact: Extract<Fact, { type: 'item' }>, seq: number): readonly WireEvent[] {
    const { item, executionId, turnId } = fact;
    if (item.type === 'tool_call') {
      if (!executionId) throw new Error('Tool call fact has no execution identity');
      return [this.#event('tool_called', { tool: { executionId, turnId, callId: item.callId,
        toolName: item.toolName, input: publicJson(item.input), status: 'called' } }, seq, turnId)];
    }
    if (item.type === 'tool_result') {
      if (!executionId) throw new Error('Tool result fact has no execution identity');
      if (this.#state.tools.some(tool => tool.executionId === executionId && tool.status === 'completed')) return [];
      return [this.#event('tool_finished', { executionId, output: item.output, isError: item.isError }, seq, turnId)];
    }
    const message = publicMessage(item, turnId, fact.modelStep, executionId);
    if (!message) return [];
    if (item.type !== 'assistant_message') return [this.#event('message', { message }, seq, turnId)];
    const step = fact.modelStep ?? 1;
    return [this.#event('message', { message, replacesDraftId: directDraftId(turnId, fact.modelStep) }, seq, turnId)];
  }
}
