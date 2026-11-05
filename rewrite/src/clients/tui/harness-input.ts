import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useEffect } from 'react';

let lastIdle: boolean | null = null;
let generation = 0;
let lastComposerValue: string | null = null;
let composerRevision = 0;

/** Publish opt-in native composer acknowledgments in the harness's idle/composer file format. */
export function useHarnessInput(active: boolean, processing: boolean, value: string): void {
  useEffect(() => {
    const path = process.env['TERM2_HARNESS_IDLE_PATH'];
    if (!path) return;

    publishComposer(path, value);

    const idle = active && !processing;
    if (idle === lastIdle) return;
    lastIdle = idle;
    if (!idle) return;

    generation += 1;
    writeAtomically(path, `${generation}\n`);
  }, [active, processing, value]);
}

/** Legacy types approval reasons and answers in its one composer; the panel's entry reports the same way. */
export function useHarnessEntry(active: boolean, value: string): void {
  useEffect(() => {
    const path = process.env['TERM2_HARNESS_IDLE_PATH'];
    if (path && active) publishComposer(path, value);
  }, [active, value]);
}

function publishComposer(path: string, value: string): void {
  if (value === lastComposerValue) return;
  lastComposerValue = value;
  composerRevision += 1;
  writeAtomically(`${path}.composer`, `${JSON.stringify({ revision: composerRevision, value })}\n`);
}

function writeAtomically(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}
