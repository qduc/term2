import type { TurnDeps } from '../engine/index.js';
import type { ShellTaskPort, ShellTaskState, ShellTaskStart } from '../tools/index.js';
import type { DirectBackgroundTasks } from './background.js';
import type { DirectTaskState } from './background-types.js';
import type { DirectOrigin } from './facade-types.js';

/** Bind admitted physical shell executions to the Session's one task owner.
 * No process, controller or lifecycle state is retained by this adapter. */
export function directShellTasks(
  tasks: DirectBackgroundTasks,
  parent: Parameters<NonNullable<TurnDeps['shellTasks']>>[0],
  origin?: DirectOrigin,
  notify?: (task: DirectTaskState, key: string, text: string) => void,
): ShellTaskPort {
  const shell = (id: string) => {
    const task = tasks.get(id);
    return task?.kind === 'shell' && task.taskId === id ? task : undefined;
  };
  const port: ShellTaskPort = {
    start<T>(request: ShellTaskStart<T>) {
      const handle = tasks.start<T>(
        {
          kind: 'shell',
          label: request.command,
          input: request.command,
          mode: request.mode,
          parentTurnId: parent.turnId,
          parentExecutionId: parent.parentExecutionId,
          parentSignal: parent.signal,
          origin,
          cleanup: request.cleanup,
        },
        async (context) => {
          const value = await request.run(context.signal);
          if (context.signal.aborted) return { kind: 'cancelled', value };
          const status = request.status?.(value) ?? 'completed';
          return status === 'completed'
            ? { kind: 'completed', value }
            : {
                kind: 'failed',
                value,
                error: { kind: 'provider', message: `Shell process ${status}`, retryable: false },
              };
        },
      );
      return {
        id: handle.taskId,
        startedAt: tasks.get(handle.taskId)!.startedAt,
        settled: handle.result.then(() => state(tasks.get(handle.taskId)!)),
        foreground: tasks.waitForForeground(handle).then((outcome) => {
          if (outcome.kind === 'background') return { kind: 'background' as const };
          if (outcome.result.value !== undefined) return { kind: 'result' as const, value: outcome.result.value };
          throw new Error(outcome.result.kind === 'failed' ? outcome.result.error.message : 'Shell task cancelled');
        }),
        notify: (key, text) => port.notify(handle.taskId, key, text),
      };
    },
    get: (id) => {
      const task = shell(id);
      return task && state(task);
    },
    list: () =>
      tasks
        .list()
        .filter((task) => task.kind === 'shell')
        .map(state),
    cancel: (id) => !!shell(id) && tasks.requestStop(id, 'model').ok,
    output: (id, chunk) => {
      const task = shell(id);
      if (!task || task.parentTurnId !== parent.turnId || task.parentExecutionId !== parent.parentExecutionId)
        return false;
      return tasks.shellProgress(id, chunk);
    },
    notify: (id, key, text) => {
      const task = shell(id);
      if (
        !task ||
        task.mode !== 'background' ||
        task.status !== 'running' ||
        task.parentTurnId !== parent.turnId ||
        task.parentExecutionId !== parent.parentExecutionId ||
        !notify
      )
        return false;
      notify(task, key, text);
      return true;
    },
  };
  return port;
}

function state(task: DirectTaskState): ShellTaskState {
  return {
    id: task.taskId,
    command: task.label,
    mode: task.mode,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    status: task.status === 'waiting_for_answer' ? 'running' : task.status,
    value: task.result?.value,
    error: task.result?.kind === 'failed' ? task.result.error.message : undefined,
  };
}
