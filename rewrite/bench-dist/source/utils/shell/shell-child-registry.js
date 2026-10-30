const processChildren = new Set();
const signalChild = (child) => {
    try {
        if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, 'SIGKILL');
        }
        else {
            child.kill('SIGKILL');
        }
    }
    catch {
        /* already gone */
    }
};
/** Per-session children with a process-wide union for final process teardown. */
export class ShellChildRegistry {
    #children = new Set();
    assertAvailable() { }
    add(child) {
        this.#children.add(child);
        processChildren.add(child);
    }
    delete(child) {
        this.#children.delete(child);
        processChildren.delete(child);
    }
    killAll() {
        for (const child of this.#children)
            signalChild(child);
        for (const child of this.#children)
            processChildren.delete(child);
        this.#children.clear();
    }
}
/** A failed graph capability rejects children registered after invalidation. */
export class InvalidatableShellChildRegistry extends ShellChildRegistry {
    #invalid = false;
    assertAvailable() {
        if (this.#invalid)
            throw new Error('Sandbox execution capability is no longer available');
    }
    add(child) {
        super.add(child);
        if (this.#invalid)
            super.killAll();
    }
    invalidate() {
        this.#invalid = true;
        super.killAll();
    }
}
/** Process-exit cleanup retains the union of every session registry. */
export function killAllShellChildrenAtProcessExit() {
    for (const child of processChildren)
        signalChild(child);
    processChildren.clear();
}
//# sourceMappingURL=shell-child-registry.js.map