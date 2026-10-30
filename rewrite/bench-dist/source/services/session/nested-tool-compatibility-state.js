import { SessionReadAccess } from '../approval/session-read-access.js';
import { DockerHostControlGrants } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { DeniedReadStore, ExecutionOverrideStore } from '../../utils/shell/sandbox/denied-read-stores.js';
/**
 * Explicit state for the legacy nested-tool approval protocol. Nested tools do
 * not receive the root post-execute capability, but their execute and approval
 * paths must share this one session-owned instance.
 */
export class NestedToolCompatibilityState {
    deniedReads = new DeniedReadStore();
    executionOverrides = new ExecutionOverrideStore();
    readAccess = new SessionReadAccess();
    docker;
    constructor(settings) {
        this.docker = new DockerHostControlGrants();
        this.docker.configure(settings);
    }
    /** Nested-only equivalent of the root read capability. */
    allowsRead(sessionId, targetPath, baseDir) {
        return this.readAccess.allows(sessionId, targetPath, baseDir);
    }
    clear(sessionId) {
        this.deniedReads.clear();
        this.executionOverrides.clear();
        this.readAccess.clear(sessionId);
        this.docker.clearSession(sessionId);
    }
}
//# sourceMappingURL=nested-tool-compatibility-state.js.map