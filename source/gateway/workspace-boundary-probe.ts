import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import type { WorkspaceGrant } from './contracts.js';
import type { WorkspaceBoundaryEvidence, WorkspaceBoundaryProbe } from './workspace-admission.js';

export type WorkspaceBoundaryProbeFs = {
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean };
  accessSync(path: string, mode: number): void;
};

const defaultFs: WorkspaceBoundaryProbeFs = { realpathSync, statSync, accessSync };

/**
 * Proves a local workspace using the canonical path and the OS user's access
 * checks. The launcher policy is deliberately part of the probe: a writable
 * filesystem is not a writable gateway grant when --allow-write is absent.
 */
export function createRealWorkspaceBoundaryProbe(options: {
  allowWrite: boolean;
  fs?: WorkspaceBoundaryProbeFs;
}): WorkspaceBoundaryProbe {
  const fs = options.fs ?? defaultFs;
  return (canonicalRoot: string, access: WorkspaceGrant['access']): WorkspaceBoundaryEvidence | false => {
    try {
      const actual = fs.realpathSync(canonicalRoot);
      if (actual !== canonicalRoot || !fs.statSync(actual).isDirectory()) return false;
      fs.accessSync(actual, constants.R_OK | constants.X_OK);
      const physicallyWritable = canWrite(fs, actual);
      return {
        mountedRoot: actual,
        writable: options.allowWrite && physicallyWritable,
        ...(access === 'read_write' && !options.allowWrite ? { policy: 'read_only_launcher' as const } : {}),
      };
    } catch {
      return false;
    }
  };
}

function canWrite(fs: WorkspaceBoundaryProbeFs, root: string): boolean {
  try {
    fs.accessSync(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
