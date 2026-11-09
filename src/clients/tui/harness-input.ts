import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useEffect } from 'react';

let lastIdle: boolean | null = null;
let generation = 0;
let lastComposerValue: string | null = null;
let composerRevision = 0;
let approvalRevision = 0;
let confirmationRevision = 0;

/** Publish opt-in native composer acknowledgments in the harness's idle/composer file format. */
export function useHarnessInput(active: boolean, processing: boolean, value: string, mounted = true): void {
  useEffect(() => {
    const path = process.env['TERM2_HARNESS_IDLE_PATH'];
    if (!path) return;

    // Legacy's input box holds its value whenever it is drawn; a draft restored into a hidden composer
    // (a rewind before its frame) is published when the composer mounts and can take keys.
    if (mounted) {
      publishComposer(path, value);
    }

    const idle = active && !processing;
    if (idle === lastIdle) return;
    lastIdle = idle;
    if (!idle) return;

    generation += 1;
    writeAtomically(path, `${generation}\n`);
  }, [active, processing, value, mounted]);
}

/** Legacy ApprovalPrompt's opt-in signal: published after the prompt's input handler is in place. */
export function publishHarnessApprovalReady(callId: string): void {
  const path = process.env['TERM2_HARNESS_IDLE_PATH'];
  if (!path) return;
  approvalRevision += 1;
  writeAtomically(`${path}.approval`, `${JSON.stringify({ revision: approvalRevision, callId })}\n`);
}

/**
 * Opt-in signal for a held-send confirmation that reads its own keys: published after
 * that prompt's input handler is in place. Ink draws the prompt at commit but subscribes
 * `useInput` in a passive effect, so a key sent on sight of the prompt can be dropped.
 */
export function publishHarnessConfirmationReady(kind: string): void {
  const path = process.env['TERM2_HARNESS_IDLE_PATH'];
  if (!path) return;
  confirmationRevision += 1;
  writeAtomically(`${path}.confirmation`, `${JSON.stringify({ revision: confirmationRevision, kind })}\n`);
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
