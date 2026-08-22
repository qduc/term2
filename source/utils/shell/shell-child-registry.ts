import type { ChildProcess } from 'node:child_process';

const processChildren = new Set<ChildProcess>();

const signalChild = (child: ChildProcess): void => {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already gone */
  }
};

/** Per-session children with a process-wide union for final process teardown. */
export class ShellChildRegistry {
  readonly #children = new Set<ChildProcess>();

  add(child: ChildProcess): void {
    this.#children.add(child);
    processChildren.add(child);
  }

  delete(child: ChildProcess): void {
    this.#children.delete(child);
    processChildren.delete(child);
  }

  killAll(): void {
    for (const child of this.#children) signalChild(child);
    for (const child of this.#children) processChildren.delete(child);
    this.#children.clear();
  }
}

/** Process-exit cleanup retains the union of every session registry. */
export function killAllShellChildrenAtProcessExit(): void {
  for (const child of processChildren) signalChild(child);
  processChildren.clear();
}
