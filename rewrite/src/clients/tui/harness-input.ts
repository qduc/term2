import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useEffect } from 'react';

let lastIdle: boolean | null = null;
let generation = 0;
let lastComposerValue: string | null = null;
let composerRevision = 0;

/** Publish opt-in native composer acknowledgments in the harness's idle/composer file format. */
export function useHarnessInput(active: boolean, processing: boolean, value: string, mounted = true): void {
  useEffect(() => {
    const path = process.env['TERM2_HARNESS_IDLE_PATH'];
    if (!path) return;

    // Legacy's input box holds its value whenever it is drawn; a draft restored into a hidden composer
    // (a rewind before its frame) is published when the composer mounts and can take keys.
    if (mounted && value !== lastComposerValue) {
      lastComposerValue = value;
      composerRevision += 1;
      writeAtomically(`${path}.composer`, `${JSON.stringify({ revision: composerRevision, value })}\n`);
    }

    const idle = active && !processing;
    if (idle === lastIdle) return;
    lastIdle = idle;
    if (!idle) return;

    generation += 1;
    writeAtomically(path, `${generation}\n`);
  }, [active, processing, value, mounted]);
}

function writeAtomically(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}
