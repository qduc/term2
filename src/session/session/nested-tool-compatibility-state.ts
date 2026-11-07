import type { DockerHostControlGrants } from '../../tools/shell/sandbox/docker-host-control-grants.js';
import type { DeniedReadStore, ExecutionOverrideStore } from '../../tools/shell/sandbox/denied-read-stores.js';
import type { NestedReadAccessPort, NestedShellAccessPort } from '../../tools/access-port.js';

export interface SessionReadAccess {
  allowFolder(sessionId: string, folder: string): void;
  allows(sessionId: string, targetPath: string, baseDir?: string): boolean;
  clear(sessionId: string): void;
}
/**
 * Optional compatibility capability supplied by a nested-tool host.
 * This contract retains no state or runtime implementation. Nested tools do
 * not receive the root post-execute capability, but their execute and approval
 * paths must share this one session-owned instance.
 */
export interface NestedToolCompatibilityState extends NestedReadAccessPort, NestedShellAccessPort {
  readonly deniedReads: DeniedReadStore;
  readonly executionOverrides: ExecutionOverrideStore;
  readonly readAccess: SessionReadAccess;
  readonly docker: DockerHostControlGrants;

  /** Nested-only equivalent of the root read capability. */
  allowsRead(sessionId: string, targetPath: string, baseDir?: string): boolean;
  clear(sessionId: string): void;
}
