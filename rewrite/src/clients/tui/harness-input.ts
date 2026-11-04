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

    if (value !== lastComposerValue) {
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
  }, [active, processing, value]);
}

function writeAtomically(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

let approvalRevision = 0;

/** Legacy's opt-in approval-prompt readiness signal (source/lib/harness-input-idle.ts), same file format. */
export function publishHarnessApprovalReady(callId: string): void {
  const path = process.env['TERM2_HARNESS_IDLE_PATH'];
  if (!path) return;
  approvalRevision += 1;
  writeAtomically(`${path}.approval`, `${JSON.stringify({ revision: approvalRevision, callId })}\n`);
}
