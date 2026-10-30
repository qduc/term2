const fileLockTails = new Map();
const activeFileLocks = new Set();
export function tryAcquireFileLock(filePath) {
    if (activeFileLocks.has(filePath) || fileLockTails.has(filePath)) {
        return null;
    }
    activeFileLocks.add(filePath);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        activeFileLocks.delete(filePath);
    };
}
export async function withFileLock(filePath, run) {
    const previous = fileLockTails.get(filePath) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    fileLockTails.set(filePath, tail);
    await previous;
    try {
        activeFileLocks.add(filePath);
        return await run();
    }
    finally {
        activeFileLocks.delete(filePath);
        release();
        if (fileLockTails.get(filePath) === tail) {
            fileLockTails.delete(filePath);
        }
    }
}
//# sourceMappingURL=file-locks.js.map