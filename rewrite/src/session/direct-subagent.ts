import type { Workspace, NestedRunRequest, NestedRunResult } from '../tools/index.js';
import { DirectBackgroundTasks } from './direct-background.js';
import type { DirectForegroundResult } from './direct-background.js';
import type {
  DirectTaskContext,
  DirectTaskHandle,
  DirectTaskId,
  DirectTaskResult,
  DirectTaskStart,
} from './direct-background-types.js';

export type DirectSubagentStart = Omit<DirectTaskStart, 'kind' | 'label' | 'role' | 'model' | 'workspace'> & {
  readonly role: string;
  readonly task: string;
  /** Already-resolved instructions/model/tool authority. Never resolve a legacy role runtime here. */
  readonly run: NestedRunRequest;
  /** An already-authorized workspace, including a pinned worker worktree when applicable. */
  readonly workspace: Workspace;
};
export type DirectSubagentContext = DirectTaskContext & {
  /** The canonical task ID is also the stable public subagent run ID. */
  readonly runId: DirectTaskId;
  readonly role: string;
  readonly workspace: Workspace;
};
/**
 * An injected capability of the direct engine, not another Session or model loop.
 * It must retain this branch until physical cleanup, observe signal, gate each
 * physical tool through the owning Session and forward pauses through interact.
 * It must not send an answer or acknowledge a tool start on its own. request
 * contains the exact resolved child authority; no access to hidden root tools.
 */
export type DirectSubagentDriver = {
  execute(request: NestedRunRequest, context: DirectSubagentContext): Promise<NestedRunResult>;
};
export type DirectSubagentHandle = DirectTaskHandle<NestedRunResult> & { readonly runId: DirectTaskId };

/**
 * Adapt resolved subagent requests/results to Session task ownership. The driver
 * executes the child branch; this module fixes its identity, origin, role/model
 * selection and workspace once at launch and preserves its exact terminal data.
 */
export class DirectSubagents {
  readonly #tasks: DirectBackgroundTasks;
  readonly #driver: DirectSubagentDriver;

  constructor(options: { readonly tasks: DirectBackgroundTasks; readonly driver: DirectSubagentDriver }) {
    if (typeof options.driver?.execute !== 'function') throw new Error('Direct nested execution is not configured.');
    this.#tasks = options.tasks;
    this.#driver = options.driver;
  }

  /** Launch a real injected child branch, returning before background execution completes. */
  start(request: DirectSubagentStart): DirectSubagentHandle {
    if (!request.role.trim() || !request.task.trim()) throw new Error('Subagent role and task must be nonempty.');
    // Freeze the selection before admission. Callers cannot rotate model/tools or
    // repin workspace by mutating the launch object after receiving its handle.
    const run = structuredClone(request.run);
    const workspace = structuredClone(request.workspace);
    const role = request.role;
    const handle = this.#tasks.start<NestedRunResult>(
      {
        kind: 'subagent',
        role,
        label: request.task,
        name: request.name,
        model: run.model,
        workspace,
        mode: request.mode,
        parentSignal: request.parentSignal,
        parentTurnId: request.parentTurnId,
        parentExecutionId: request.parentExecutionId,
        sourceCallId: request.sourceCallId,
        origin: request.origin,
      },
      async (context) => {
        const result = await this.#driver.execute(run, {
          ...context,
          runId: context.task.taskId,
          role,
          workspace,
        });
        return taskResult(result);
      },
    );
    return { ...handle, runId: handle.taskId };
  }

  /** Return terminal data or a transfer handle; transfer never manufactures child success. */
  waitForForeground(handle: DirectSubagentHandle): Promise<DirectForegroundResult<NestedRunResult>> {
    return this.#tasks.waitForForeground(handle);
  }
}

function taskResult(result: NestedRunResult): DirectTaskResult<NestedRunResult> {
  switch (result.outcome.kind) {
    case 'background':
      throw new Error('A branch driver must settle the actual child, not return a launch handle');
    case 'completed':
      return { kind: 'completed', value: result };
    case 'cancelled':
      return { kind: 'cancelled', value: result };
    case 'failed':
      return { kind: 'failed', error: result.outcome.error, value: result };
    case 'budget_exhausted':
      return { kind: 'interrupted', reason: 'budget_exhausted', value: result };
    case 'interrupted':
      return { kind: 'interrupted', reason: result.outcome.terminalCause ?? 'interrupted', value: result };
  }
}
