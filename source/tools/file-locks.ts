const fileLockTails = new Map<string, Promise<void>>();

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
    return await run();
  } finally {
    release();
    if (fileLockTails.get(filePath) === tail) {
      fileLockTails.delete(filePath);
    }
  }
}
