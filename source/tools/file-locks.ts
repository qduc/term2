const fileLockTails = new Map<string, Promise<void>>();
const activeFileLocks = new Set<string>();

export function tryAcquireFileLock(filePath: string): (() => void) | null {
  if (activeFileLocks.has(filePath) || fileLockTails.has(filePath)) {
    return null;
  }

  activeFileLocks.add(filePath);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFileLocks.delete(filePath);
  };
}

export async function withFileLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = fileLockTails.get(filePath) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );

  fileLockTails.set(filePath, tail);
  await previous;

  try {
    activeFileLocks.add(filePath);
    return await run();
  } finally {
    activeFileLocks.delete(filePath);
    release();
    if (fileLockTails.get(filePath) === tail) {
      fileLockTails.delete(filePath);
    }
  }
}
