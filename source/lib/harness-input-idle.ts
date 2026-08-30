import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InputOwner } from './input-owner.js';

/** Opt-in path. Unset outside isolated harness children. */
export const HARNESS_IDLE_ENV = 'TERM2_HARNESS_IDLE_PATH';

type PublishedPhase = 'idle' | 'busy';

let lastPhase: PublishedPhase | null = null;
let generation = 0;

export type HarnessInputState = {
  readonly owner: InputOwner['kind'];
  readonly processing: boolean;
};

/** Publish only on a transition into composer-owned idle. File holds the generation. */
export function publishHarnessInputState(state: HarnessInputState): void {
  const path = process.env[HARNESS_IDLE_ENV];
  if (!path) return;

  const idle = state.owner === 'input' && !state.processing;
  const next: PublishedPhase = idle ? 'idle' : 'busy';
  if (next === lastPhase) return;
  lastPhase = next;
  if (!idle) return;

  generation += 1;
  const payload = `${generation}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

export function readHarnessIdleGeneration(path: string): number {
  if (!existsSync(path)) return 0;
  const parsed = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function waitForHarnessIdleGeneration(
  path: string,
  options: { after?: number; timeoutMs?: number } = {},
): Promise<number> {
  const after = options.after ?? 0;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = readHarnessIdleGeneration(path);
    if (current > after) return current;
    await delay(20);
  }
  throw new Error(
    `Timed out waiting for harness idle generation > ${after} at ${path} after ${timeoutMs}ms; got ${readHarnessIdleGeneration(
      path,
    )}.`,
  );
}

export function resetHarnessInputIdleForTests(): void {
  lastPhase = null;
  generation = 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
