import { expect, it } from 'vitest';
import { restoreProcessState, snapshotProcessState } from './vitest-process-state.js';

it('puts back an environment key that a file changed, added or removed', () => {
  const keep = process.env.PATH;
  process.env.TERM2_PS_CHANGED = 'before';
  const snapshot = snapshotProcessState();
  try {
    process.env.TERM2_PS_CHANGED = 'after';
    process.env.TERM2_PS_ADDED = 'x';
    delete process.env.PATH;

    const leaked = restoreProcessState(snapshot);

    expect(process.env.TERM2_PS_CHANGED).toBe('before');
    expect(process.env.TERM2_PS_ADDED).toBeUndefined();
    expect(process.env.PATH).toBe(keep);
    expect(leaked.env).toEqual(expect.arrayContaining(['~TERM2_PS_CHANGED', '+TERM2_PS_ADDED', '-PATH']));
  } finally {
    delete process.env.TERM2_PS_CHANGED;
    delete process.env.TERM2_PS_ADDED;
    if (keep !== undefined) process.env.PATH = keep;
  }
});

// A test that does `process.env = { ...saved }` swaps Node's environment object for a plain
// object. Assignments then stop reaching the real environment, which a newly created worker
// thread reads, so every later file in the same process sees a broken environment.
it('puts back the real environment object when a file replaced it', () => {
  const realEnv = process.env;
  const snapshot = snapshotProcessState();
  try {
    // leak-scan-allow env-swap: the swap is the behavior under test, restored in finally.
    process.env = { ...realEnv };
    expect(process.env).not.toBe(realEnv);

    const leaked = restoreProcessState(snapshot);

    expect(process.env).toBe(realEnv);
    expect(leaked.envReplaced).toBe(true);
  } finally {
    // leak-scan-allow env-swap
    process.env = realEnv;
  }
});

it('removes application-owned globals but keeps ones a library installed', () => {
  const snapshot = snapshotProcessState();
  const g = globalThis as Record<string, unknown>;
  try {
    g.__term2TestOwned = 1;
    g.IS_SOME_LIBRARY_FLAG = true;

    restoreProcessState(snapshot);

    expect('__term2TestOwned' in g).toBe(false);
    expect(g.IS_SOME_LIBRARY_FLAG).toBe(true);
  } finally {
    delete g.__term2TestOwned;
    delete g.IS_SOME_LIBRARY_FLAG;
  }
});

it('reports nothing when a file left nothing behind', () => {
  const snapshot = snapshotProcessState();
  expect(restoreProcessState(snapshot)).toEqual({});
});
