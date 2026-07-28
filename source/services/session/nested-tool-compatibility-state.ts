import type { ISettingsService } from '../service-interfaces.js';
import { SessionReadAccess } from '../approval/session-read-access.js';
import { DockerHostControlGrants } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { DeniedReadStore, ExecutionOverrideStore } from '../../utils/shell/sandbox/denied-read-stores.js';

/**
 * Explicit state for the legacy nested-tool approval protocol. Nested tools do
 * not receive the root post-execute capability, but their execute and approval
 * paths must share this one session-owned instance.
 */
export class NestedToolCompatibilityState {
  readonly deniedReads = new DeniedReadStore();
  readonly executionOverrides = new ExecutionOverrideStore();
  readonly readAccess = new SessionReadAccess();
  readonly docker: DockerHostControlGrants;

  constructor(settings: ISettingsService) {
    this.docker = new DockerHostControlGrants();
    this.docker.configure(settings);
  }

  /** Nested-only equivalent of the root read capability. */
  allowsRead(sessionId: string, targetPath: string, baseDir?: string): boolean {
    return this.readAccess.allows(sessionId, targetPath, baseDir);
  }

  clear(sessionId: string): void {
    this.deniedReads.clear();
    this.executionOverrides.clear();
    this.readAccess.clear(sessionId);
    this.docker.clearSession(sessionId);
  }
}
