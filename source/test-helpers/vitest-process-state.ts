// Snapshot and restore of the process-level state a test file can leave behind.
// Used by vitest-reset-modules.ts so files that share a worker start from the state an
// isolated run would give them. Only state this module can put back faithfully is reset;
// handles that outlive a file (sockets, timers, child processes) are not.

export interface ProcessSnapshot {
  envObject: NodeJS.ProcessEnv;
  env: NodeJS.ProcessEnv;
  cwd: string;
  globals: Set<string | symbol>;
}

export interface LeakReport {
  env?: string[];
  envReplaced?: true;
  cwd?: string;
  globals?: string[];
}

export function snapshotProcessState(): ProcessSnapshot {
  return {
    envObject: process.env,
    env: { ...process.env },
    cwd: process.cwd(),
    globals: new Set(Reflect.ownKeys(globalThis)),
  };
}

export function restoreProcessState(snapshot: ProcessSnapshot): LeakReport {
  const leaked: LeakReport = {};

  // `process.env = {...}` swaps Node's environment object for a plain object, after which
  // assignments no longer reach the real environment (a new worker thread reads that one).
  // Put the real object back before comparing keys.
  if (process.env !== snapshot.envObject) {
    process.env = snapshot.envObject;
    leaked.envReplaced = true;
  }

  const envChanged: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot.env)) {
      envChanged.push(`+${key}`);
      delete process.env[key];
    } else if (process.env[key] !== snapshot.env[key]) {
      envChanged.push(`~${key}`);
      process.env[key] = snapshot.env[key];
    }
  }
  for (const key of Object.keys(snapshot.env)) {
    if (!(key in process.env)) {
      envChanged.push(`-${key}`);
      process.env[key] = snapshot.env[key];
    }
  }
  if (envChanged.length) leaked.env = envChanged;

  if (process.cwd() !== snapshot.cwd) {
    leaked.cwd = process.cwd();
    process.chdir(snapshot.cwd);
  }

  // Only application-owned globals are removed. Third-party libraries are loaded once per
  // worker and install globals at import (React's act flag, zod's registry, undici's
  // dispatcher); deleting those would break later files because the library does not run
  // its setup again. They are reported instead.
  const added = Reflect.ownKeys(globalThis).filter((key) => !snapshot.globals.has(key));
  for (const key of added) {
    const owned = typeof key === 'string' && /^(__)?term2/i.test(key);
    if (owned && Object.getOwnPropertyDescriptor(globalThis, key)?.configurable)
      Reflect.deleteProperty(globalThis, key);
  }
  if (added.length) leaked.globals = added.map(String);

  return leaked;
}
