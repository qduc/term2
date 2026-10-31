import type { InteractionRequestId } from '../tools/index.js';
import type { DirectBackgroundFact, DirectTaskId, DirectTaskState } from './direct-background-types.js';

/**
 * Pure projection of accepted task facts. Session can fold this alongside its
 * transcript projection; live promises/abort controllers are never recovered.
 * Input must already have passed the owning log's schema/version validation.
 */
export function projectDirectBackground(facts: readonly DirectBackgroundFact[]): readonly DirectTaskState[] {
  const tasks = new Map<DirectTaskId, DirectTaskState>();
  const requestIds = new Set<InteractionRequestId>();
  for (const fact of facts) applyFact(tasks, requestIds, fact);
  return structuredClone([...tasks.values()]);
}

/** Incremental public projection; Session separately reserves all historical request IDs. */
export function reduceDirectBackground(
  states: readonly DirectTaskState[],
  fact: DirectBackgroundFact,
): readonly DirectTaskState[] {
  const tasks = new Map(states.map((task) => [task.taskId, task]));
  const requestIds = new Set(states.flatMap((task) => task.pendingInteractions.map((request) => request.requestId)));
  applyFact(tasks, requestIds, fact);
  return structuredClone([...tasks.values()]);
}

/**
 * Propose explicit unknown outcomes for tasks left live by process loss. Session
 * appends these only on a later explicit action, through its sole writer. No
 * operation, continuation or answer is replayed; terminal results remain exact.
 */
export function recoverDirectBackground(
  facts: readonly DirectBackgroundFact[],
  at: number,
): readonly DirectBackgroundFact[] {
  const recovery: DirectBackgroundFact[] = [];
  for (const task of projectDirectBackground(facts)) {
    if (terminal(task)) continue;
    for (const request of task.pendingInteractions) {
      recovery.push({
        type: 'task_interaction_closed',
        taskId: task.taskId,
        requestId: request.requestId,
        resolution: { kind: 'interrupted' },
      });
    }
    recovery.push({
      type: 'task_finished',
      taskId: task.taskId,
      at,
      result: { kind: 'interrupted', reason: 'outcome_unobserved' },
    });
  }
  return recovery;
}

function applyFact(
  tasks: Map<DirectTaskId, DirectTaskState>,
  requestIds: Set<InteractionRequestId>,
  fact: DirectBackgroundFact,
): void {
  if (fact.type === 'task_started') {
    if (tasks.has(fact.task.taskId)) throw new Error('Duplicate task start.');
    tasks.set(fact.task.taskId, {
      ...fact.task,
      mode: fact.mode,
      status: 'running',
      lastActivityAt: fact.task.startedAt,
      pendingInteractions: [],
    });
    return;
  }
  const taskId = fact.type === 'task_interaction_opened' ? fact.request.taskId : fact.taskId;
  const task = tasks.get(taskId);
  if (!task || terminal(task)) throw new Error('Task fact has no live owning task.');
  switch (fact.type) {
    case 'task_backgrounded':
      if (task.mode === 'background' || task.status === 'cancelling')
        throw new Error('Task cannot transfer ownership.');
      tasks.set(taskId, { ...task, mode: 'background' });
      break;
    case 'task_stop_requested':
      if (task.status === 'cancelling') throw new Error('Duplicate task stop.');
      tasks.set(taskId, { ...task, status: 'cancelling' });
      break;
    case 'task_finished':
      if (task.pendingInteractions.length) throw new Error('Task finished with unresolved interactions.');
      tasks.set(taskId, { ...task, status: fact.result.kind, completedAt: fact.at, result: fact.result });
      break;
    case 'task_interaction_opened':
      if (fact.request.sessionId !== task.sessionId || task.status === 'cancelling')
        throw new Error('Invalid task interaction owner.');
      if (requestIds.has(fact.request.requestId)) throw new Error('Duplicate task interaction ID.');
      requestIds.add(fact.request.requestId);
      tasks.set(taskId, {
        ...task,
        status: 'waiting_for_answer',
        pendingInteractions: [...task.pendingInteractions, fact.request],
      });
      break;
    case 'task_interaction_closed': {
      if (!task.pendingInteractions.some((request) => request.requestId === fact.requestId))
        throw new Error('Task interaction is not pending.');
      const pendingInteractions = task.pendingInteractions.filter((request) => request.requestId !== fact.requestId);
      const status =
        task.status === 'cancelling' ? 'cancelling' : pendingInteractions.length ? 'waiting_for_answer' : 'running';
      tasks.set(taskId, { ...task, status, pendingInteractions });
      break;
    }
  }
}

function terminal(task: DirectTaskState): boolean {
  return task.result !== undefined;
}
