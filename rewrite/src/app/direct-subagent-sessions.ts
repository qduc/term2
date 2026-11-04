/**
 * Legacy SubagentAsyncRegistry's session reuse, over Session tasks: a background run continued by
 * `continue_run_id`, and the shared `role:librarian` session every fresh background librarian run joins,
 * carry the earlier conversation forward and refuse a second concurrent run on the same session.
 * The run's history is its admitted input items plus the accepted items of its result.
 */
import type { Item } from '../model/index.js';
import type { NestedRunResult, SubagentTaskState } from '../tools/index.js';

type Definition = { readonly canWrite?: boolean };
/** Legacy SubagentRegistryError, supplied by the caller (its code and message are the tool's output). */
type RegistryError = (code: string, message: string) => Error;

type Run<D> = {
  readonly key: string;
  readonly role: string;
  readonly input: readonly Item[];
  readonly definition: D;
};
type Tasks = { get(id: string): SubagentTaskState | undefined };
/** What a launch inherits: its session key, the history before its task, and (continuations) the definition. */
export type PriorSession<D> = {
  readonly key: string;
  /** A continuation's kept run ID. */
  readonly runId?: string;
  readonly history: readonly Item[];
  readonly definition?: D;
};

const CONTINUABLE = ['agent', 'mentor', 'librarian', 'explorer', 'reviewer'];
const SHARED_ROLES = new Set(['mentor', 'librarian']);

export class DirectSubagentSessions<D extends Definition> {
  readonly #runs = new Map<string, Run<D>>();
  /** `messageCap` is legacy's subagent.asyncMessageCap: a reused session keeps its last N user turns. */
  constructor(readonly error: RegistryError, readonly messageCap: () => number) {}
  readonly #latest = new Map<string, string>();

  /** Legacy startRun's continuation and shared-session admission, in its order and wording. */
  prior(
    params: { readonly continue_run_id?: string; readonly role?: string },
    mode: 'foreground' | 'background',
    tasks: Tasks | undefined,
  ): PriorSession<D> | undefined {
    if (mode !== 'background') return undefined;
    const role = params.role ?? 'agent';
    const continuation = params.continue_run_id;
    let prior: PriorSession<D> | undefined;
    if (continuation) {
      const run = this.#runs.get(continuation);
      const task = tasks?.get(continuation);
      if (!run || !task) throw this.error('not_found', `Async subagent run not found: ${continuation}`);
      if (run.role !== role)
        throw this.error('role_mismatch', `Run ${continuation} belongs to role ${run.role}, not ${role}`);
      if (!task.result) throw this.error('already_active', `Async subagent run ${continuation} is already active`);
      if (task.result.kind !== 'completed')
        throw this.error(
          'not_continuable',
          `Async subagent run ${continuation} cannot be continued from status ${task.result.kind}`,
        );
      if (role === 'worker' || run.definition.canWrite === true)
        throw this.error('worker_blocked', 'Worker runs cannot be continued asynchronously');
      if (!CONTINUABLE.includes(role)) throw this.error('not_continuable', `Role ${role} cannot be continued`);
      prior = { key: run.key, runId: continuation, history: this.#history(run, task), definition: run.definition };
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
        throw this.error('already_active', `Session for role ${role} is already active`);
    return prior;
  }

  /** Remember an admitted background run, so a later continuation or shared launch can find it. */
  record(runId: string, role: string, key: string | undefined, input: readonly Item[], definition: D) {
    const sessionKey = key ?? runId;
    this.#runs.set(runId, { key: sessionKey, role, input, definition });
    this.#latest.set(sessionKey, runId);
  }

  #history(run: Run<D>, task: SubagentTaskState): readonly Item[] {
    const value = task.result?.value as NestedRunResult | undefined;
    const history = [...run.input, ...(Array.isArray(value?.items) ? value.items : [])];
    // Legacy trimUserTurns: keep history from the Nth-last user turn; a cap of 0 or less keeps none.
    const cap = this.messageCap();
    const turns = history.flatMap((item, index) => (item.type === 'user_message' ? [index] : []));
    if (cap <= 0) return [];
    return turns.length <= cap ? history : history.slice(turns[turns.length - cap]);
  }
}
