/** Term2 capabilities bound to the engine's current physical tool execution. */
import type { ExecutionId, TurnDeps, TurnId, ToolContextBinding } from '../engine/index.js';
import type {
  ShellTaskPort,
  ShellTaskStart,
  SubagentTaskPort,
  Term2ToolAppContext,
  ToolContextSeed,
} from '../tools/index.js';

export type ToolExecutionParent = {
  readonly turnId: TurnId;
  readonly parentExecutionId: ExecutionId;
  readonly signal: AbortSignal;
};
export type Term2ToolPorts = {
  readonly subagents?: (parent: ToolExecutionParent) => SubagentTaskPort;
  readonly shellTasks?: (parent: ToolExecutionParent) => ShellTaskPort;
  readonly askOrchestrator?: (question: string) => Promise<string>;
};

/** App ports stay outside the engine; binding access follows nested scripted leaves. */
export function bindTerm2ToolContext(
  deps: Omit<TurnDeps<Term2ToolAppContext>, 'toolContext' | 'createToolContext'> &
    Term2ToolPorts & { readonly toolContext?: ToolContextSeed },
): TurnDeps<Term2ToolAppContext> {
  const {
    subagents: _subagents,
    shellTasks: _shellTasks,
    askOrchestrator: _askOrchestrator,
    toolContext,
    ...engine
  } = deps;
  return {
    ...engine,
    ...(toolContext
      ? { createToolContext: (binding: ToolContextBinding) => appContext(toolContext, deps, binding) }
      : {}),
  };
}

function appContext(seed: ToolContextSeed, ports: Term2ToolPorts, binding: ToolContextBinding): Term2ToolAppContext {
  // Capture identity on each operation, before a task detaches from the ALS execution scope.
  const parent = (): ToolExecutionParent => ({
    turnId: binding.turnId,
    parentExecutionId: binding.parentExecutionId,
    signal: binding.signal,
  });
  const controls = () => {
    binding.assertActive();
    if (!ports.subagents) throw new Error('Session subagent controls are unavailable');
    return ports.subagents(parent());
  };
  const ownedShell = () => {
    binding.assertActive();
    binding.assertCanStart();
    return ports.shellTasks!(parent());
  };
  return {
    ...seed,
    ...(ports.shellTasks
      ? {
          shellTasks: {
            start: <T>(request: ShellTaskStart<T>) => {
              const handle = ownedShell().start(request);
              if (request.mode === 'foreground') binding.parked();
              return handle;
            },
            get: (id: string) => ownedShell().get(id),
            list: () => ownedShell().list(),
            cancel: (id: string) => ownedShell().cancel(id),
            output: (id: string, chunk: string) => ports.shellTasks!(parent()).output(id, chunk),
            notify: (id: string, key: string, text: string) => ports.shellTasks!(parent()).notify(id, key, text),
          },
        }
      : {}),
    ...(ports.askOrchestrator
      ? {
          askOrchestrator: (question: string) => {
            binding.assertActive();
            binding.parked();
            return ports.askOrchestrator!(question);
          },
        }
      : {}),
    ...(ports.subagents
      ? {
          subagents: {
            list: () => controls().list(),
            get: (target: string) => controls().get(target),
            wait: (target: string, signal: AbortSignal) => {
              const port = controls();
              binding.parked();
              return port.wait(target, signal);
            },
            cancel: (target: string) => controls().cancel(target),
            message: (target: string, message: string, replyTo?: string) =>
              controls().message(target, message, replyTo),
          },
        }
      : {}),
  };
}
