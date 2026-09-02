import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InputOwner } from './input-owner.js';

/** Opt-in path. Unset outside isolated harness children. */
export const HARNESS_IDLE_ENV = 'TERM2_HARNESS_IDLE_PATH';

type PublishedPhase = 'idle' | 'busy';

let lastPhase: PublishedPhase | null = null;
let generation = 0;
let lastComposerValue: string | null = null;
let composerRevision = 0;

export type HarnessInputState = {
  readonly owner: InputOwner['kind'];
  readonly processing: boolean;
  readonly inputValue?: string;
};

export type HarnessComposerState = {
  readonly revision: number;
  readonly value: string;
};

/** Publish only on a transition into composer-owned idle. File holds the generation. */
export function publishHarnessInputState(state: HarnessInputState): void {
  const path = process.env[HARNESS_IDLE_ENV];
  if (!path) return;

  if (state.inputValue !== undefined && state.inputValue !== lastComposerValue) {
    lastComposerValue = state.inputValue;
    composerRevision += 1;
    writeAtomically(
      composerStatePath(path),
      `${JSON.stringify({ revision: composerRevision, value: state.inputValue })}\n`,
    );
  }

  const idle = state.owner === 'input' && !state.processing;
  const next: PublishedPhase = idle ? 'idle' : 'busy';
  if (next === lastPhase) return;
  lastPhase = next;
  if (!idle) return;

  generation += 1;
  writeAtomically(path, `${generation}\n`);
}

export function readHarnessComposerState(path: string): HarnessComposerState | null {
  const statePath = composerStatePath(path);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<HarnessComposerState>;
    if (!Number.isInteger(parsed.revision) || (parsed.revision ?? 0) < 1 || typeof parsed.value !== 'string') {
      return null;
    }
    return { revision: parsed.revision!, value: parsed.value };
  } catch {
    return null;
  }
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

export async function waitForHarnessComposerValue(
  path: string,
  value: string,
  options: { afterRevision?: number; timeoutMs?: number } = {},
): Promise<HarnessComposerState> {
  const afterRevision = options.afterRevision ?? 0;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = readHarnessComposerState(path);
    if (current && current.revision > afterRevision && current.value === value) return current;
    await delay(20);
  }
  const current = readHarnessComposerState(path);
  throw new Error(
    `Timed out waiting for composer value acknowledgement after revision ${afterRevision} at ${composerStatePath(
      path,
    )} after ${timeoutMs}ms; got revision ${current?.revision ?? 0}.`,
  );
}

export function resetHarnessInputIdleForTests(): void {
  lastPhase = null;
  generation = 0;
  lastComposerValue = null;
  composerRevision = 0;
}

function composerStatePath(idlePath: string): string {
  return `${idlePath}.composer`;
}

function writeAtomically(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
