/** One translation from accepted direct Session updates to wire events.
 * Session alone commits/answers; this class only maintains the public read model.
 */
import type { DirectSessionState, DirectSessionUpdate } from '../session/facade-types.js';
import { directDraftId, initialDirectState } from '../session/direct-state.js';
import { contextFactEvent } from './direct-context.js';
import type { DirectQueueState } from '../session/direct-queue-types.js';
import { createDirectQueueState, directQueueSteeredInput, reduceDirectQueue } from '../session/direct-queue-state.js';
import { argumentStreamEvent } from './direct-argument-stream.js';
import { commandFactEvent } from './direct-command-receipts.js';
import { publicRequestCost } from './direct-costs.js';
import { budgetFactEvent } from './direct-budget.js';
import { completedFinalText } from './direct-turn-results.js';
import { publicQueue, publicQueueChange } from './direct-queue.js';
import { taskFactEvent } from './direct-tasks.js';
import type { Fact } from '../session/facts.js';
import type { WireEvent, WireEventPayloads, WireEventType, WireSnapshot } from './direct-wire.js';
import { publicInteraction, publicJson, publicMessage, publicToolContent, publicTerminal } from './direct-public.js';
import { runtimeDirectError, snapshotDirectState } from './direct-state.js';
import { reduceWireEvent } from './direct-reducer.js';

/** The published native update vocabulary, including original accepted timestamps. */
export type DirectProtocolUpdate = DirectSessionUpdate;
type FactUpdate = Extract<DirectProtocolUpdate, { type: 'fact' }>;
export class DirectProjection {
  #state: WireSnapshot;
  #queue: DirectQueueState;
  #workspace: DirectSessionState['workspace'];
  #branches = new Map<string, { readonly projection: DirectProjection; readonly taskId: string; readonly parentTurnId?: string; readonly rootTurnId?: string; readonly role?: string }>();
  constructor(state: DirectSessionState & { readonly queue?: DirectQueueState }, seq: number | null = null) {
    this.#state = { ...snapshotDirectState(state), seq };
    this.#workspace = state.workspace;
    this.#queue = state.queue ?? createDirectQueueState();
  }
  /** Reconstruct historical context from Session-owned accepted facts, not current state. */
  static forReplay(state: DirectSessionState): DirectProjection {
    const projection = new DirectProjection(initialDirectState(state.id, state.workspace, state.model), 0);
    projection.#state = { ...projection.#state, timeline: [] };
    return projection;
  }
  get snapshot(): WireSnapshot { return this.#state; }

  /** Updates arrive once in Session publication order; never called from a tool body. */
  update(update: DirectProtocolUpdate): readonly WireEvent[] {
    let events: readonly WireEvent[];
    if (update.type === 'state') return this.synchronize(update.state);
    if (update.type === 'transient') {
      if (update.event.type === 'tool_call_streaming_delta') {
        events = [argumentStreamEvent(this.#state.sessionId, update.event)];
      } else if (update.event.type === 'automatic_memory_notice') {
        const { success, command, output } = update.event.notice;
        events = [this.#event('automatic_memory_notice', { success, command, output }, null, this.#state.activeTurnId)];
      } else if (update.event.type === 'task_progress') {
        const progress = update.event;
        const task = this.#state.tasks.find(task => task.id === progress.taskId);
        const { type: _type, ...payload } = progress;
        events = [this.#event('task_progress', payload, null, task?.turnId ?? null)];
      } else events = update.event.type === 'reasoning_delta'
        ? [this.#event('reasoning_delta', { delta: update.event.delta, modelStep: null, messageId: null }, null, this.#state.activeTurnId)]
        : [this.#event('tool_progress', { executionId: update.event.executionId, chunk: update.event.chunk }, null,
          this.#state.tools.find(tool => tool.executionId === update.event.executionId)?.turnId ?? null)];
    } else {
      events = this.#fact(update);
    }
    events = events.map(event => ({ ...event, occurredAt: update.type === 'fact' ? update.at ?? null : null }));
    for (const event of events) this.#state = reduceWireEvent(this.#state, event);
    if (update.type === 'fact') this.#state = { ...this.#state, seq: update.seq };
    return events;
  }
  /** Apply an atomic captured state AFTER its accepted prefix; no domain event is accepted here. */
  synchronize(state: DirectSessionState): readonly WireEvent[] {
      if ('queue' in state && state.queue) this.#queue = state.queue as DirectQueueState;
      const snapshot = snapshotDirectState(state, this.#state);
      const error = runtimeDirectError(state);
      const freshError = error && (error.kind !== this.#state.lastError?.kind || error.message !== this.#state.lastError?.message);
      // A poisoned writer reports a real semantic failure through state, not a fact.
      // Settle event-driven consumers too, while the following authoritative snapshot
      // retains the Session's interrupted status and does not invent a durable terminal.
      const events: readonly WireEvent[] = [
        ...(freshError ? [this.#event('error', { error }, null, this.#state.activeTurnId)] : []),
        ...(freshError && this.#state.activeTurnId ? [this.#event('turn_ended', { outcome: 'failed', error }, null, this.#state.activeTurnId)] : []),
        this.#event('snapshot', { snapshot }, null, null),
      ];

      for (const event of events) this.#state = reduceWireEvent(this.#state, event);
      return events;
  }
  #event<K extends WireEventType>(type: K, payload: WireEventPayloads[K], seq: number | null, turnId: string | null): WireEvent {
    return { sessionId: this.#state.sessionId, seq, occurredAt: null, turnId, type, payload } as WireEvent;
  }
  #fact({ fact, seq, at }: FactUpdate): readonly WireEvent[] {
    const turnId = 'turnId' in fact ? fact.turnId ?? null : null;
    switch (fact.type) {
      case 'goal_changed':
      case 'goal_proposed':
      case 'goal_stop_reminded':
      case 'completion_verification_started':
      case 'completion_verification_decided':
      case 'completion_verification_reported':
      case 'completion_verification_ended':
      case 'memory_global_snapshot':
      case 'memory_personal_snapshot':
      case 'automatic_memory_started':
      case 'automatic_memory_finished':
      case 'automatic_memory_disabled': return [contextFactEvent(fact, this.#state, seq)];
      case 'queue_submitted':
      case 'queue_edited':
      case 'queue_retracted':
      case 'queue_discarded':
      case 'queue_started':
      case 'queue_steered':
      case 'queue_cancelling':
      case 'queue_settled':
      case 'queue_resumed':
      case 'queue_recovered': {
        const messages = fact.type === 'queue_steered'
          ? directQueueSteeredInput(this.#queue, fact).flatMap(item => { const message = publicMessage(item, fact.turnId); return message ? [message] : []; })
          : [];
        this.#queue = reduceDirectQueue(this.#queue, fact);
        const queue = publicQueue(this.#queue, this.#state.turnResults);
        return [this.#event('queue_changed', { change: publicQueueChange(fact), entries: queue.queue, state: queue.queueState, pauseReason: queue.queuePauseReason, submissions: queue.submissions,
          ...(fact.type === 'queue_submitted' ? { admission: fact.record.admission } : {}),
          ...(messages.length ? { messages } : {}),
        }, seq, turnId)];
      }
      case 'task_started':
      case 'task_backgrounded':
      case 'task_stop_requested':
      case 'task_finished':
      case 'task_interaction_opened':
      case 'task_interaction_closed': return [taskFactEvent(fact, this.#state, seq)];
      case 'background_notice_enqueued': return [this.#event('background_notice_enqueued', { notice: structuredClone(fact.notice) }, seq, null)];
      case 'background_notices_delivered': return [this.#event('background_notices_delivered', { clientRequestId: fact.clientRequestId, turnId: fact.turnId, notificationIds: [...fact.notificationIds] }, seq, fact.turnId)];
      case 'command_started':
      case 'command_finished': return [commandFactEvent(fact, this.#state, seq)];
      case 'request_cost_recorded': return [this.#event('request_cost_recorded', publicRequestCost(fact), seq, fact.turnId)];
      case 'budget_opened':
      case 'budget_closed':
      case 'budget_observed': return [budgetFactEvent(fact, this.#state.sessionId, seq)];
      case 'history_replaced': return [this.#event('history_replaced', { reason: fact.reason }, seq, turnId)];
      case 'model_response_completed': return [this.#event('model_response_completed', {
        modelStep: fact.modelStep, stopReason: fact.stopReason, ...(fact.costUsd !== undefined ? { costUsd: fact.costUsd } : {}),
      }, seq, turnId)];
      case 'branch_started': {
        const task = this.#state.tasks.find(task => task.id === fact.taskId);
        const projection = DirectProjection.forReplay(initialDirectState(this.#state.sessionId, this.#workspace, task?.model ?? this.#state.model));
        const parentTurnId = fact.parentTurnId ?? task?.turnId;
        this.#branches.set(fact.branchId, { projection, taskId: fact.taskId,
          ...(parentTurnId !== undefined ? { parentTurnId } : {}),
          ...(fact.rootTurnId !== undefined ? { rootTurnId: fact.rootTurnId } : {}),
          ...(task?.role ? { role: task.role } : {}),
        });
        return this.#branch(fact.branchId, { type: 'turn_started', turnId: fact.turnId, input: fact.input }, seq, at);
      }
      case 'branch_event': return this.#branch(fact.branchId, fact.fact, seq, at);
      case 'session_started': return [this.#event('configuration', { model: fact.model, ...(fact.reasoning ? { reasoning: fact.reasoning } : {}) }, seq, null)];
      case 'turn_started': return [
        this.#event('turn_started', { foreground: true, ...(fact.silent ? { silent: true as const } : {}),
          ...(fact.submission ? { admission: { kind: 'started' as const, clientRequestId: fact.submission.clientRequestId, messageId: fact.submission.messageId, turnId: fact.turnId } } : {}),
          input: fact.silent ? [] : fact.input.flatMap(item => { const message = publicMessage(item, fact.turnId); return message ? [message] : []; }),
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
        executionId: fact.executionId, ...this.#toolIdentity(fact.executionId), output: fact.result.output, isError: fact.result.isError,
        ...(fact.result.display !== undefined ? { display: publicJson(fact.result.display) } : {}),
        ...(fact.result.providerOutput ? { content: publicToolContent(fact.result.providerOutput) } : {}),
      }, seq, turnId)];
      case 'interaction_opened': return [this.#event('interaction_opened', { interaction: publicInteraction(fact.request) }, seq, turnId)];
      case 'interaction_closed': return [this.#event('interaction_resolved', { requestId: fact.requestId, resolution: fact.resolution, ...(fact.resolutionSource ? { provenance: { source: fact.resolutionSource, ...(fact.automaticApproval !== undefined ? { automaticApproval: fact.automaticApproval } : {}) } } : {}) }, seq, turnId)];
      case 'usage': return [this.#event('usage', { usage: fact.usage }, seq, turnId)];
      case 'turn_ended': return [this.#event('turn_ended', { ...publicTerminal(fact), finalText: completedFinalText(fact.outcome, this.#state.messages.filter(message => message.turnId === fact.turnId)) }, seq, turnId)];
    }
  }
  #toolIdentity(executionId: string) {
    const tool = this.#state.tools.find(tool => tool.executionId === executionId);
    return tool ? { toolName: tool.toolName, input: tool.input,
      ...(tool.callId ? { callId: tool.callId } : {}), ...(tool.parentExecutionId ? { parentExecutionId: tool.parentExecutionId } : {}),
    } : {};
  }
  /** Branch facts keep their one outer cursor; child frames never advance the root cursor. */
  #branch(branchId: string, fact: Fact, seq: number, at: string): readonly WireEvent[] {
    const branch = this.#branches.get(branchId);
    if (!branch) throw new Error('Branch event has no accepted branch identity');
    return branch.projection.update({ type: 'fact', position: 0, seq, at, fact }).map(event =>
      this.#event('subagent', { agentId: branch.taskId, branchId,
        ...(branch.parentTurnId !== undefined ? { parentTurnId: branch.parentTurnId } : {}),
        ...(branch.rootTurnId !== undefined ? { rootTurnId: branch.rootTurnId } : {}),
        ...(branch.role ? { role: branch.role } : {}), event: { ...event, seq: null } }, seq, branch.parentTurnId ?? null));
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
      // The provider-facing result is a separate accepted fact. Upsert by occurrence
      // instead of suppressing it using current capture state during historical replay.
      return [this.#event('tool_finished', { executionId, ...this.#toolIdentity(executionId), output: item.output, isError: item.isError,
        ...(item.providerOutput ? { content: publicToolContent(item.providerOutput) } : {}),
      }, seq, turnId)];
    }
    if (item.type === 'reasoning') return [this.#event('reasoning', { text: item.summary, messageId: item.id, modelStep: fact.modelStep ?? null }, seq, turnId)];
    const message = publicMessage(item, turnId, fact.modelStep, executionId);
    if (!message) return [];
    if (item.type !== 'assistant_message') return [this.#event('message', { message }, seq, turnId)];
    return [this.#event('message', { message, replacesDraftId: directDraftId(turnId, fact.modelStep) }, seq, turnId)];
  }
}
