import { rotationConfiguration, branchSnapshots, projectItem } from './direct-projection-parts.js';
/** One translation from accepted direct Session updates to wire events.
 * Session alone commits/answers; this class only maintains the public read model.
 */
import type { DirectSessionState, DirectSessionUpdate } from '../session/facade-types.js';
import { directDraftId, initialDirectState } from '../session/direct-state.js';
import { contextFactEvent } from './direct-context.js';
import type { DirectQueueState } from '../session/direct-queue-types.js';
import { createDirectQueueState, directQueueSteeredInput } from '../session/direct-queue-state.js';
import { foldFact } from '../session/fold-fact.js';
import { argumentStreamEvent } from './direct-argument-stream.js';
import { commandFactEvent } from './direct-command-receipts.js';
import { publicRequestCost } from './direct-costs.js';
import { budgetFactEvent } from './direct-budget.js';
import { publicCompactionCompleted, publicCompactionFailed, publicCompactionStarted } from './direct-compaction.js';
import { completedFinalText } from './direct-turn-results.js';
import { publicQueue, publicQueueChange } from './direct-queue.js';
import { taskFactEvent } from './direct-tasks.js';
import type { Fact } from '../session/facts.js';
import { withNotice } from '../session/direct-input-notice.js';
import type { WireEvent, WireEventPayloads, WireEventType, WireSnapshot } from './direct-wire.js';
import {
  contentText,
  publicContent,
  publicInteraction,
  publicJson,
  publicMessage,
  publicToolContent,
  publicTerminal,
} from './direct-public.js';
import { runtimeDirectError, snapshotDirectState } from './direct-state.js';
import { reduceWireEvent } from './direct-reducer.js';

/** The published native update vocabulary, including original accepted timestamps. */
export type DirectProtocolUpdate = DirectSessionUpdate;
type FactUpdate = Extract<DirectProtocolUpdate, { type: 'fact' }>;
export class DirectProjection {
  #state: WireSnapshot;
  #queue: DirectQueueState;
  #workspace: DirectSessionState['workspace'];
  #branches = new Map<
    string,
    {
      readonly projection: DirectProjection;
      readonly taskId: string;
      readonly turnId: string;
      acceptedSeq: number;
      hasAcceptedUsage: boolean;
      readonly parentTurnId?: string;
      readonly rootTurnId?: string;
      readonly role?: string;
    }
  >();
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
  /** One public root/branch cut; no log read or second clock is introduced. */
  get snapshot(): WireSnapshot {
    return { ...this.#state, branches: branchSnapshots(this.#branches, this.#state) };
  }

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
        const task = this.#state.tasks.find((task) => task.id === progress.taskId);
        const { type: _type, ...payload } = progress;
        events = [this.#event('task_progress', payload, null, task?.turnId ?? null)];
      } else if (update.event.type === 'retrying') {
        const { type: _type, ...retry } = update.event;
        events = [this.#event('retrying', retry, null, this.#state.activeTurnId)];
      } else if (update.event.type === 'codex_quota') {
        events = [this.#event('codex_quota', { quota: update.event.quota }, null, this.#state.activeTurnId)];
      } else if (update.event.type === 'reasoning_delta') {
        events = [
          this.#event(
            'reasoning_delta',
            { delta: update.event.delta, modelStep: null, messageId: null },
            null,
            this.#state.activeTurnId,
          ),
        ];
      } else {
        const progress = update.event;
        events = [
          this.#event(
            'tool_progress',
            { executionId: progress.executionId, chunk: progress.chunk },
            null,
            this.#state.tools.find((tool) => tool.executionId === progress.executionId)?.turnId ?? null,
          ),
        ];
      }
    } else {
      events = this.#fact(update);
    }
    events = events.map((event) => ({ ...event, occurredAt: update.type === 'fact' ? update.at ?? null : null }));
    for (const event of events) this.#state = reduceWireEvent(this.#state, event);
    if (update.type === 'fact') this.#state = { ...this.#state, seq: update.seq };
    return events;
  }
  /** Apply an atomic captured state AFTER its accepted prefix; no domain event is accepted here. */
  synchronize(state: DirectSessionState): readonly WireEvent[] {
    if ('queue' in state && state.queue) this.#queue = state.queue as DirectQueueState;
    const snapshot = snapshotDirectState(state, this.#state);
    const error = runtimeDirectError(state);
    const freshError =
      error && (error.kind !== this.#state.lastError?.kind || error.message !== this.#state.lastError?.message);
    // A poisoned writer reports a real semantic failure through state, not a fact.
    // Settle event-driven consumers too, while the following authoritative snapshot
    // retains the Session's interrupted status and does not invent a durable terminal.
    const events: readonly WireEvent[] = [
      ...(freshError ? [this.#event('error', { error }, null, this.#state.activeTurnId)] : []),
      ...(freshError && this.#state.activeTurnId
        ? [this.#event('turn_ended', { outcome: 'failed', error }, null, this.#state.activeTurnId)]
        : []),
      this.#event(
        'snapshot',
        { snapshot: { ...snapshot, branches: branchSnapshots(this.#branches, snapshot) } },
        null,
        null,
      ),
    ];

    for (const event of events) this.#state = reduceWireEvent(this.#state, event);
    return events;
  }
  #event<K extends WireEventType>(
    type: K,
    payload: WireEventPayloads[K],
    seq: number | null,
    turnId: string | null,
  ): WireEvent {
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
      case 'automatic_memory_disabled':
        return [contextFactEvent(fact, this.#state, seq)];
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
        const messages =
          fact.type === 'queue_steered'
            ? directQueueSteeredInput(this.#queue, fact).flatMap((item) => {
                const message = publicMessage(item, fact.turnId);
                return message ? [message] : [];
              })
            : [];
        this.#queue = foldFact({ queue: this.#queue }, fact).queue;
        const queue = publicQueue(this.#queue, this.#state.turnResults);
        return [
          this.#event(
            'queue_changed',
            {
              change: publicQueueChange(fact),
              entries: queue.queue,
              state: queue.queueState,
              pauseReason: queue.queuePauseReason,
              submissions: queue.submissions,
              ...(fact.type === 'queue_submitted' ? { admission: fact.record.admission } : {}),
              ...(messages.length ? { messages } : {}),
            },
            seq,
            turnId,
          ),
        ];
      }
      case 'task_started':
      case 'task_backgrounded':
      case 'task_stop_requested':
      case 'task_finished':
      case 'task_interaction_opened':
      case 'task_question_opened':
      case 'task_question_closed':
      case 'task_interaction_closed':
        return [taskFactEvent(fact, this.#state, seq)];
      case 'background_notice_enqueued':
        return [this.#event('background_notice_enqueued', { notice: structuredClone(fact.notice) }, seq, null)];
      case 'background_notices_delivered':
        return [
          this.#event(
            'background_notices_delivered',
            { clientRequestId: fact.clientRequestId, turnId: fact.turnId, notificationIds: [...fact.notificationIds] },
            seq,
            fact.turnId,
          ),
        ];
      case 'command_started':
      case 'command_finished':
        return [commandFactEvent(fact, this.#state, seq)];
      case 'configuration_changed':
        return [
          this.#event(
            'configuration',
            {
              model: { provider: fact.configuration.model.provider, model: fact.configuration.model.model },
              ...(fact.configuration.reasoning !== undefined ? { reasoning: fact.configuration.reasoning } : {}),
              ...(fact.configuration.temperature !== undefined ? { temperature: fact.configuration.temperature } : {}),
            },
            seq,
            null,
          ),
        ];
      case 'request_cost_recorded':
        return [this.#event('request_cost_recorded', publicRequestCost(fact), seq, fact.turnId)];
      case 'compaction_started':
        return [this.#event('compaction_started', publicCompactionStarted(fact), seq, fact.turnId)];
      case 'compaction_completed':
        return [this.#event('compaction_completed', publicCompactionCompleted(fact), seq, fact.turnId)];
      case 'compaction_failed':
        return [this.#event('compaction_failed', publicCompactionFailed(fact), seq, fact.turnId)];
      // Accepted handoff intent; the successor boundary is the public session_rotated frame.
      case 'rollover_requested':
        return [];
      case 'session_rotated':
        return [
          this.#event(
            'session_rotated',
            {
              logicalSessionId: fact.logicalSessionId,
              backingSessionId: fact.sessionId,
              predecessor: { ...fact.predecessor },
              commandId: fact.commandId,
              configuration: rotationConfiguration(fact),
              ...(fact.handoff ? { handoff: { ...fact.handoff } } : {}),
            },
            seq,
            null,
          ),
        ];
      case 'budget_opened':
      case 'budget_closed':
      case 'budget_observed':
        return [budgetFactEvent(fact, this.#state.sessionId, seq)];
      case 'history_replaced':
        return [
          this.#event(
            'history_replaced',
            {
              reason: fact.reason,
              ...(fact.retainTranscript ? { retainTranscript: true as const } : {}),
              ...(fact.compactionId !== undefined ? { compactionId: fact.compactionId } : {}),
            },
            seq,
            turnId,
          ),
        ];
      case 'model_response_completed':
        return [
          this.#event(
            'model_response_completed',
            {
              modelStep: fact.modelStep,
              stopReason: fact.stopReason,
              ...(fact.costUsd !== undefined ? { costUsd: fact.costUsd } : {}),
            },
            seq,
            turnId,
          ),
        ];
      case 'branch_started': {
        const task = this.#state.tasks.find((task) => task.id === fact.taskId);
        const projection = DirectProjection.forReplay(
          initialDirectState(this.#state.sessionId, this.#workspace, task?.model ?? this.#state.model),
        );
        const parentTurnId = fact.parentTurnId;
        this.#branches.set(fact.branchId, {
          projection,
          taskId: fact.taskId,
          turnId: fact.turnId,
          acceptedSeq: seq,
          hasAcceptedUsage: false,
          ...(parentTurnId !== undefined ? { parentTurnId } : {}),
          ...(fact.rootTurnId !== undefined ? { rootTurnId: fact.rootTurnId } : {}),
          ...(task?.role ? { role: task.role } : {}),
        });
        return this.#branch(fact.branchId, { type: 'turn_started', turnId: fact.turnId, input: fact.input }, seq, at);
      }
      case 'branch_event':
        return this.#branch(fact.branchId, fact.fact, seq, at);
      case 'session_started':
        return [
          this.#event(
            'configuration',
            { model: fact.model, ...(fact.reasoning ? { reasoning: fact.reasoning } : {}) },
            seq,
            null,
          ),
        ];
      case 'transcript_message': {
        const content = publicContent(fact.message.content);
        return [
          this.#event(
            'message',
            {
              message: {
                ...fact.message,
                content,
                text: contentText(content),
                ...(fact.turnId ? { turnId: fact.turnId } : {}),
              },
            },
            seq,
            turnId,
          ),
        ];
      }
      case 'turn_started':
        return [
          this.#event(
            'turn_started',
            {
              foreground: true,
              ...(fact.silent ? { silent: true as const } : {}),
              ...(fact.submission
                ? {
                    admission: {
                      kind: 'started' as const,
                      clientRequestId: fact.submission.clientRequestId,
                      messageId: fact.submission.messageId,
                      turnId: fact.turnId,
                    },
                  }
                : {}),
              input:
                fact.silent || fact.display === false
                  ? []
                  : (fact.persistentNotice ? withNotice(fact.input, fact.persistentNotice) : fact.input).flatMap(
                      (item) => {
                        const message = publicMessage(item, fact.turnId);
                        return message ? [message] : [];
                      },
                    ),
            },
            seq,
            turnId,
          ),
        ];
      case 'text_delta': {
        const step = fact.modelStep ?? 1;
        if (fact.withdrawn) return []; // it leaves with the next state snapshot
        return [
          this.#event(
            'text_delta',
            { delta: fact.delta, modelStep: step, messageId: directDraftId(fact.turnId, fact.modelStep) },
            seq,
            turnId,
          ),
        ];
      }
      case 'item':
        return projectItem(fact, seq, this.#event.bind(this), this.#toolIdentity.bind(this));
      case 'tool_started':
        return [
          this.#event(
            'tool_started',
            {
              tool: {
                executionId: fact.executionId,
                turnId: fact.turnId,
                callId: fact.callId,
                toolName: fact.toolName,
                input: publicJson(fact.input),
                status: 'started',
                ...(fact.parentExecutionId ? { parentExecutionId: fact.parentExecutionId } : {}),
              },
            },
            seq,
            turnId,
          ),
        ];
      case 'tool_finished':
        return [
          this.#event(
            'tool_finished',
            {
              executionId: fact.executionId,
              ...this.#toolIdentity(fact.executionId),
              output: fact.result.output,
              isError: fact.result.isError,
              ...(fact.result.display !== undefined ? { display: publicJson(fact.result.display) } : {}),
              ...(fact.result.providerOutput ? { content: publicToolContent(fact.result.providerOutput) } : {}),
            },
            seq,
            turnId,
          ),
        ];
      case 'interaction_opened':
        return [this.#event('interaction_opened', { interaction: publicInteraction(fact.request) }, seq, turnId)];
      case 'interaction_closed':
        return [
          this.#event(
            'interaction_resolved',
            {
              requestId: fact.requestId,
              resolution: fact.resolution,
              ...(fact.resolutionSource
                ? {
                    provenance: {
                      source: fact.resolutionSource,
                      ...(fact.automaticApproval !== undefined ? { automaticApproval: fact.automaticApproval } : {}),
                    },
                  }
                : {}),
            },
            seq,
            turnId,
          ),
        ];
      case 'usage':
        return [this.#event('usage', { usage: fact.usage, ...(fact.speed ? { speed: fact.speed } : {}) }, seq, turnId)];
      case 'turn_ended':
        return [
          this.#event(
            'turn_ended',
            {
              ...publicTerminal(fact),
              finalText: completedFinalText(
                fact.outcome,
                this.#state.messages.filter((message) => message.turnId === fact.turnId),
              ),
            },
            seq,
            turnId,
          ),
        ];
    }
  }
  #toolIdentity(executionId: string) {
    const tool = this.#state.tools.find((tool) => tool.executionId === executionId);
    return tool
      ? {
          toolName: tool.toolName,
          input: tool.input,
          ...(tool.callId ? { callId: tool.callId } : {}),
          ...(tool.parentExecutionId ? { parentExecutionId: tool.parentExecutionId } : {}),
        }
      : {};
  }
  /** Branch facts keep their one outer cursor; child frames never advance the root cursor. */
  #branch(branchId: string, fact: Fact, seq: number, at: string): readonly WireEvent[] {
    const branch = this.#branches.get(branchId);
    if (!branch) throw new Error('Branch event has no accepted branch identity');
    // The wrapper is the accepted outer boundary for a branch fact. Preserve its
    // real accepted timestamp; nested child frames keep the existing null root cursor.
    const events = branch.projection.update({ type: 'fact', position: 0, seq, at, fact });
    branch.acceptedSeq = seq;
    if (fact.type === 'usage') branch.hasAcceptedUsage = true;
    return events.map((event) => ({
      ...this.#event(
        'subagent',
        {
          agentId: branch.taskId,
          branchId,
          turnId: branch.turnId,
          ...(branch.parentTurnId !== undefined ? { parentTurnId: branch.parentTurnId } : {}),
          ...(branch.rootTurnId !== undefined ? { rootTurnId: branch.rootTurnId } : {}),
          ...(branch.role ? { role: branch.role } : {}),
          event: { ...event, seq: null },
        },
        seq,
        branch.parentTurnId ?? null,
      ),
      occurredAt: at,
    }));
  }
}
