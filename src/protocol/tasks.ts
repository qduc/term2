/** Mapping of the committed M4 helper data, not a task runner or durable owner.
 * Session must accept/validate these facts and expose task state before production use.
 */
import type {
  DirectBackgroundFact,
  DirectTaskInteraction,
  DirectTaskResult,
  DirectTaskState,
} from '../session/background-types.js';
import type { WireEvent, WireSnapshot, WireTask, WireTaskOwner, WireTaskResult, WireToolUseCount } from './wire.js';
import { parseWireOrigin } from './parse.js';
import { publicInteraction } from './public.js';

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
    const text = item.content
      .filter(
        (part: unknown) =>
          part &&
          typeof part === 'object' &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string',
      )
      .map((part: { text: string }) => part.text)
      .join('');
    if (text) texts.push(text);
  }
  return texts.length ? texts.join('\n') : undefined;
}
function toolUseCounts(value: unknown): readonly WireToolUseCount[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>).toolUseCounts;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const counts: WireToolUseCount[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const { toolName, count } = item as Record<string, unknown>;
    if (typeof toolName !== 'string' || toolName.length === 0 || names.has(toolName)) return undefined;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return undefined;
    names.add(toolName);
    counts.push({ toolName, count });
  }
  return counts;
}
export function publicTaskResult(result: DirectTaskResult): WireTaskResult {
  const text = 'value' in result ? output(result.value) : undefined;
  const counts = 'value' in result ? toolUseCounts(result.value) : undefined;
  return {
    kind: result.kind,
    ...(text !== undefined ? { output: text } : {}),
    ...(counts !== undefined ? { toolUseCounts: counts } : {}),
    ...(result.kind === 'failed'
      ? { error: { kind: result.error.kind, message: result.error.message, retryable: result.error.retryable } }
      : {}),
    ...(result.kind === 'interrupted' ? { reason: result.reason } : {}),
  };
}
/** Only actual descriptor fields are copied; workspace paths and nested items remain private. */
export function publicTask(task: DirectTaskState): WireTask {
  const result = task.result ? publicTaskResult(task.result) : undefined;
  return {
    id: task.taskId,
    sessionId: task.sessionId,
    turnId: task.parentTurnId,
    ...(task.parentExecutionId ? { parentExecutionId: task.parentExecutionId } : {}),
    ...(task.sourceCallId ? { sourceCallId: task.sourceCallId } : {}),
    ...(task.origin ? { origin: parseWireOrigin(task.origin) } : {}),
    kind: task.kind,
    label: task.label,
    ...(task.input !== undefined ? { input: task.input } : {}),
    ...(task.name ? { name: task.name } : {}),
    ...(task.role ? { role: task.role } : {}),
    ...(task.kind === 'subagent' ? { agentId: task.taskId } : {}),
    ...(task.model ? { model: { provider: task.model.provider, model: task.model.model } } : {}),
    mode: task.mode,
    status: task.status === 'waiting_for_answer' ? 'awaiting_interaction' : task.status,
    ...(task.pendingQuestion ? { pendingQuestion: structuredClone(task.pendingQuestion) } : {}),
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(result ? { result, ...(result.output !== undefined ? { text: result.output } : {}) } : {}),
  };
}
/** Carry accepted descriptor ownership without publishing workspace or private result data. */
export function publicTaskOwner(task: WireTask): WireTaskOwner {
  return {
    id: task.id,
    turnId: task.turnId,
    sessionId: task.sessionId,
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
    return {
      ...base,
      turnId: fact.task.parentTurnId,
      type: 'task_changed',
      payload: {
        change: fact.type,
        at: fact.task.startedAt,
        task: publicTask({
          ...fact.task,
          mode: fact.mode,
          status: 'running',
          lastActivityAt: fact.task.startedAt,
          pendingInteractions: [],
        }),
      },
    };
  }
  const taskId = fact.type === 'task_interaction_opened' ? fact.request.taskId : fact.taskId;
  const task = state.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error('Task fact has no projected task identity');
  if (fact.type === 'task_interaction_opened') {
    return {
      ...base,
      turnId: task.turnId ?? null,
      type: 'interaction_opened',
      payload: { interaction: publicTaskInteraction(fact.request, task) },
    };
  }
  if (fact.type === 'task_interaction_closed') {
    return {
      ...base,
      turnId: task.turnId ?? null,
      type: 'interaction_resolved',
      payload: {
        taskId: fact.taskId,
        taskOwner: publicTaskOwner(task),
        requestId: fact.requestId,
        resolution: fact.resolution.kind === 'decision' ? fact.resolution.decision : fact.resolution,
      },
    };
  }
  if (fact.type === 'task_question_opened' || fact.type === 'task_question_closed') {
    const next: WireTask = {
      ...task,
      lastActivityAt: fact.at,
      pendingQuestion: fact.type === 'task_question_opened' ? fact.question : undefined,
      status:
        task.status === 'cancelling'
          ? 'cancelling'
          : fact.type === 'task_question_opened' ||
            state.pendingInteractions.some((request) => request.taskId === taskId)
          ? 'awaiting_interaction'
          : 'running',
    };
    return {
      ...base,
      turnId: task.turnId ?? null,
      type: 'task_changed',
      payload: { change: fact.type, at: fact.at, task: next },
    };
  }
  let next: WireTask;
  switch (fact.type) {
    case 'task_backgrounded':
      next = { ...task, mode: 'background' };
      break;
    case 'task_stop_requested':
      next = { ...task, status: 'cancelling' };
      break;
    case 'task_finished': {
      const result = publicTaskResult(fact.result);
      next = {
        ...task,
        status: result.kind,
        completedAt: fact.at,
        result,
        ...(result.output !== undefined ? { text: result.output } : {}),
      };
      break;
    }
  }
  return {
    ...base,
    turnId: task.turnId ?? null,
    type: 'task_changed',
    payload: { change: fact.type, at: fact.at, task: next },
  };
}
