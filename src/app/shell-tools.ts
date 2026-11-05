import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentFactoryDeps } from './lib/agent-factory.js';
import type {
  BackgroundShellRegistryPort,
  BackgroundShellJob,
  BackgroundShellLaunchOptions,
} from '../tools/shell/background-shell-registry.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';
import { BackgroundShellOutputStore } from '../tools/shell/background-shell-output-store.js';
import { BackgroundShellWatches, type BackgroundShellWatchesPort } from '../tools/shell/background-shell-watches.js';
import type { ShellTaskPort, ShellTaskState } from '../tools/index.js';
import { sourceToolContext } from './source-tools.js';

/** Translate the source shell's prepared runner into native Session leases.
 * This keeps no task registry: identity, state, abort and cleanup settlement all
 * stay with Session. The source shell still performs approval and preparation. */
export function createDirectShellTools() {
  const scope = new AsyncLocalStorage<ShellTaskPort>();
  // Output/watch callbacks only, never task lifecycle or cancellation state.
  const outputs = new Map<string, (key: string, text: string) => boolean>();
  const watchJobs = new Map<string, string>();
  const store = new BackgroundShellOutputStore();
  const watches = new BackgroundShellWatches({
    store,
    scheduler: {
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    onFiring: (firing) => outputs.get(firing.jobId)?.(`${firing.watchId}:${firing.seq}`, JSON.stringify(firing)),
  });
  const current = () => {
    const port = scope.getStore();
    if (!port) throw new Error('Shell operation has no admitted Session execution');
    return port;
  };
  const job = (task: ShellTaskState): BackgroundShellJob<BackgroundShellExecutionResult> => {
    const result = task.value as BackgroundShellExecutionResult | undefined;
    return {
      id: task.id,
      command: task.command,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      status:
        task.status === 'interrupted'
          ? 'failed'
          : task.status === 'completed'
          ? result?.status ?? 'completed'
          : task.status,
      result,
      error: task.error,
    };
  };
  const start = (
    options: BackgroundShellLaunchOptions<BackgroundShellExecutionResult>,
    mode: 'foreground' | 'background',
  ) => {
    const port = current();
    const handle = port.start({
      command: options.command,
      mode,
      run: options.run,
      status: options.resultToStatus,
      cleanup: async () => {
        try {
          await options.onSettled?.();
        } finally {
          outputs.delete(handle.id);
          for (const [watchId, jobId] of watchJobs) if (jobId === handle.id) watchJobs.delete(watchId);
        }
      },
    });
    outputs.set(handle.id, handle.notify);
    // Session schedules the body after returning this admitted handle.
    options.onStarted?.(handle.id);
    return { handle, settled: handle.settled.then(job) };
  };
  const registry: BackgroundShellRegistryPort<BackgroundShellExecutionResult> = {
    launch(options) {
      const { handle, settled } = start(options, 'background');
      // A background lease has no foreground waiter; observe rejection on stop.
      void handle.foreground.catch(() => {});
      return {
        id: handle.id,
        command: options.command,
        status: 'running',
        startedAt: handle.startedAt,
        settled,
      };
    },
    startForeground(options) {
      const { handle, settled } = start(options, 'foreground');
      return {
        callId: options.callId,
        jobId: handle.id,
        command: options.command,
        status: 'running',
        startedAt: handle.startedAt,
        settled,
        foregroundResult: handle.foreground.then((outcome) => {
          if (outcome.kind === 'result') return outcome.value;
          options.onAdopted?.();
          return { jobId: handle.id, status: 'running' as const };
        }),
      };
    },
    get(id) {
      const task = current().get(id);
      return task && task.mode === 'background' ? job(task) : undefined;
    },
    list: () =>
      current()
        .list()
        .filter((task) => task.mode === 'background')
        .map(job),
    cancel: (id) => (current().get(id)?.mode === 'background' ? current().cancel(id) : false),
    recordOutputChunk: (id, _stream, text) => current().output(id, text ?? ''),
  };
  const withInvocation: NonNullable<AgentFactoryDeps['withToolInvocation']> = (_name, invocation, operation) => {
    const context = sourceToolContext(invocation);
    if (!context.shellTasks) return operation();
    return scope.run(context.shellTasks, operation);
  };
  // One retained surface can serve several Sessions. A watch ID alone must not
  // grant control over another Session's output subscription.
  const scopedWatches: BackgroundShellWatchesPort = {
    open: (id) => watches.open(id),
    push: (id, stream, text) => watches.push(id, stream, text),
    settleJob: (id) => watches.settleJob(id),
    setOnFiring: (callback) => watches.setOnFiring(callback),
    registerWatch(options) {
      if (!current().get(options.jobId)) throw new Error('Shell job is not owned by this Session');
      const id = watches.registerWatch(options);
      watchJobs.set(id, options.jobId);
      return id;
    },
    cancelWatch(id) {
      const jobId = watchJobs.get(id);
      if (!jobId || !current().get(jobId)) return false;
      watchJobs.delete(id);
      return watches.cancelWatch(id);
    },
  };
  return {
    registry,
    output: { store, watches: scopedWatches },
    withInvocation,
    dispose: () => {
      for (const id of outputs.keys()) watches.settleJob(id);
      outputs.clear();
      watchJobs.clear();
      scope.disable();
    },
  };
}
