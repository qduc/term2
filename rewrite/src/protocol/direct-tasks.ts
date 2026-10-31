/** Mapping of the committed M4 helper data, not a task runner or durable owner.
 * Session must accept/validate these facts and expose task state before production use.
 */
import type { DirectBackgroundFact, DirectTaskInteraction, DirectTaskResult, DirectTaskState } from '../session/direct-background-types.js';
import type { WireEvent, WireSnapshot, WireTask, WireTaskOwner, WireTaskResult } from './direct-wire.js';
import { parseWireOrigin } from './direct-parse.js';
import { publicInteraction } from './direct-public.js';

/** Known public output only. Never expose a nested provider transcript or arbitrary result value. */
function output(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.output === 'string') return data.output;
  if (!Array.isArray(data.items)) return undefined;
  const texts: string[] = [];
  for (const item of data.items) {
    if (!item || item.type !== 'assistant_message' || !Array.isArray(item.content)) continue;
    const text = item.content.filter((part: unknown) => part && typeof part === 'object' &&
      'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
      .map((part: { text: string }) => part.text).join('');
    if (text) texts.push(text);
  }
  return texts.length ? texts.join('\n') : undefined;
}
export function publicTaskResult(result: DirectTaskResult): WireTaskResult {
  const text = 'value' in result ? output(result.value) : undefined;
  return { kind: result.kind, ...(text !== undefined ? { output: text } : {}),
    ...(result.kind === 'failed' ? { error: { kind: result.error.kind, message: result.error.message, retryable: result.error.retryable } } : {}),
    ...(result.kind === 'interrupted' ? { reason: result.reason } : {}),
  };
}
/** Only actual descriptor fields are copied; workspace paths and nested items remain private. */
export function publicTask(task: DirectTaskState): WireTask {
  const result = task.result ? publicTaskResult(task.result) : undefined;
  return {
    id: task.taskId, sessionId: task.sessionId, turnId: task.parentTurnId,
    ...(task.parentExecutionId ? { parentExecutionId: task.parentExecutionId } : {}),
    ...(task.sourceCallId ? { sourceCallId: task.sourceCallId } : {}),
    ...(task.origin ? { origin: parseWireOrigin(task.origin) } : {}),
    kind: task.kind, label: task.label, ...(task.name ? { name: task.name } : {}),
    ...(task.role ? { role: task.role } : {}), ...(task.kind === 'subagent' ? { agentId: task.taskId } : {}),
    ...(task.model ? { model: { provider: task.model.provider, model: task.model.model } } : {}),
    mode: task.mode, status: task.status === 'waiting_for_answer' ? 'awaiting_interaction' : task.status,
    startedAt: task.startedAt, lastActivityAt: task.lastActivityAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(result ? { result, ...(result.output !== undefined ? { text: result.output } : {}) } : {}),
  };
}
/** Carry accepted descriptor ownership without publishing workspace or private result data. */
export function publicTaskOwner(task: WireTask): WireTaskOwner {
  return {
    id: task.id, turnId: task.turnId, sessionId: task.sessionId,
    ...(task.parentExecutionId ? { parentExecutionId: task.parentExecutionId } : {}),
    ...(task.sourceCallId ? { sourceCallId: task.sourceCallId } : {}),
    ...(task.origin ? { origin: task.origin } : {}),
    ...(task.kind ? { kind: task.kind } : {}),
    ...(task.name ? { name: task.name } : {}),
    ...(task.role ? { role: task.role } : {}),
  };
}
/** The request keeps its real child turn; its owner retains the accepted parent/role. */
export function publicTaskInteraction(request: DirectTaskInteraction, task: WireTask) {
  return { ...publicInteraction(request), taskOwner: publicTaskOwner(task) };
}
/** One accepted task fact maps to one cursor-addressable event, never a root answer. */
export function taskFactEvent(fact: DirectBackgroundFact, state: WireSnapshot, seq: number): WireEvent {
  const base = { sessionId: state.sessionId, seq };
  if (fact.type === 'task_started') {
    return { ...base, turnId: fact.task.parentTurnId, type: 'task_changed',
      payload: { change: fact.type, at: fact.task.startedAt,
        task: publicTask({ ...fact.task, mode: fact.mode, status: 'running', lastActivityAt: fact.task.startedAt, pendingInteractions: [] }) } };
  }
  const taskId = fact.type === 'task_interaction_opened' ? fact.request.taskId : fact.taskId;
  const task = state.tasks.find(task => task.id === taskId);
  if (!task) throw new Error('Task fact has no projected task identity');
  if (fact.type === 'task_interaction_opened') {
    return { ...base, turnId: task.turnId ?? null, type: 'interaction_opened',
      payload: { interaction: publicTaskInteraction(fact.request, task) } };
  }
  if (fact.type === 'task_interaction_closed') {
    return { ...base, turnId: task.turnId ?? null, type: 'interaction_resolved', payload: {
      taskId: fact.taskId, taskOwner: publicTaskOwner(task), requestId: fact.requestId,
      resolution: fact.resolution.kind === 'decision' ? fact.resolution.decision : fact.resolution,
    } };
  }
  let next: WireTask;
  switch (fact.type) {
    case 'task_backgrounded': next = { ...task, mode: 'background' }; break;
    case 'task_stop_requested': next = { ...task, status: 'cancelling' }; break;
    case 'task_finished': {
      const result = publicTaskResult(fact.result);
      next = { ...task, status: result.kind, completedAt: fact.at, result, ...(result.output !== undefined ? { text: result.output } : {}) };
      break;
    }
  }
  return { ...base, turnId: task.turnId ?? null, type: 'task_changed', payload: { change: fact.type, at: fact.at, task: next } };
}
