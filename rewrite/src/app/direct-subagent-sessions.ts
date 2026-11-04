/**
 * Legacy SubagentAsyncRegistry's session reuse, over Session tasks: a background run continued by
 * `continue_run_id`, and the shared `role:librarian` session every fresh background librarian run joins,
 * carry the earlier conversation forward and refuse a second concurrent run on the same session.
 * The run's history is its admitted input items plus the accepted items of its result.
 */
import type { SubagentDefinition } from '../../../source/services/subagents/types.js';
import { SubagentRegistryError } from '../../../source/services/subagents/subagent-async-registry.js';
import type { Item } from '../model/index.js';
import type { NestedRunResult, SubagentTaskState } from '../tools/index.js';

type Run = {
  readonly key: string;
  readonly role: string;
  readonly input: readonly Item[];
  readonly definition: SubagentDefinition;
};
type Tasks = { get(id: string): SubagentTaskState | undefined };
/** What a launch inherits: its session key, the history before its task, and (continuations) the definition. */
export type PriorSession = {
  readonly key: string;
  readonly history: readonly Item[];
  readonly definition?: SubagentDefinition;
};

const CONTINUABLE = ['agent', 'mentor', 'librarian', 'explorer', 'reviewer'];
const SHARED_ROLES = new Set(['librarian']);

export class DirectSubagentSessions {
  readonly #runs = new Map<string, Run>();
  readonly #latest = new Map<string, string>();

  /** Legacy startRun's continuation and shared-session admission, in its order and wording. */
  prior(
    params: { readonly continue_run_id?: string; readonly role?: string },
    mode: 'foreground' | 'background',
    tasks: Tasks | undefined,
  ): PriorSession | undefined {
    if (mode !== 'background') return undefined;
    const role = params.role ?? 'agent';
    const continuation = params.continue_run_id;
    let prior: PriorSession | undefined;
    if (continuation) {
      const run = this.#runs.get(continuation);
      const task = tasks?.get(continuation);
      if (!run || !task) throw new SubagentRegistryError('not_found', `Async subagent run not found: ${continuation}`);
      if (run.role !== role)
        throw new SubagentRegistryError(
          'role_mismatch',
          `Run ${continuation} belongs to role ${run.role}, not ${role}`,
        );
      if (!task.result)
        throw new SubagentRegistryError('already_active', `Async subagent run ${continuation} is already active`);
      if (task.result.kind !== 'completed')
        throw new SubagentRegistryError(
          'not_continuable',
          `Async subagent run ${continuation} cannot be continued from status ${task.result.kind}`,
        );
      if (role === 'worker' || run.definition.canWrite === true)
        throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
      if (!CONTINUABLE.includes(role))
        throw new SubagentRegistryError('not_continuable', `Role ${role} cannot be continued`);
      prior = { key: run.key, history: this.#history(run, task), definition: run.definition };
    } else if (SHARED_ROLES.has(role)) {
      const key = `role:${role}`;
      const latest = this.#latest.get(key);
      const run = latest ? this.#runs.get(latest) : undefined;
      const task = latest ? tasks?.get(latest) : undefined;
      prior = { key, history: run && task?.result ? this.#history(run, task) : [] };
    }
    if (!prior) return undefined;
    for (const [id, run] of this.#runs)
      if (run.key === prior.key && tasks?.get(id) && !tasks.get(id)!.result)
        throw new SubagentRegistryError('already_active', `Session for role ${role} is already active`);
    return prior;
  }

  /** Remember an admitted background run, so a later continuation or shared launch can find it. */
  record(runId: string, role: string, key: string | undefined, input: readonly Item[], definition: SubagentDefinition) {
    const sessionKey = key ?? runId;
    this.#runs.set(runId, { key: sessionKey, role, input, definition });
    this.#latest.set(sessionKey, runId);
  }

  #history(run: Run, task: SubagentTaskState): readonly Item[] {
    const value = task.result?.value as NestedRunResult | undefined;
    return [...run.input, ...(Array.isArray(value?.items) ? value.items : [])];
  }
}
