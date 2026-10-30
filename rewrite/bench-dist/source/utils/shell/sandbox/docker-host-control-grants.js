import fs from 'node:fs';
import path from 'node:path';
import { requestsDockerHostControl } from './docker-host-control.js';
const realRoot = (cwd) => {
    const resolved = path.resolve(cwd);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
};
/** Narrow capability grant store. Persistence is intentionally limited to user settings. */
export class DockerHostControlGrants {
    #settings;
    #onceBySession = new Map();
    #sessionRootsBySession = new Map();
    #deniedBySession = new Map();
    /**
     * A sandboxed run of this command was blocked from the Docker daemon.
     *
     * Scoped to the session that hit the block: the record is what later grants a
     * command host control, so another session must not inherit it. A run with no
     * session identity cannot be attributed, so it is dropped rather than recorded
     * globally — the command stays sandboxed instead of gaining unearned access.
     */
    recordDenial(sessionId, command) {
        if (!sessionId)
            return;
        const commands = this.#deniedBySession.get(sessionId) ?? new Set();
        commands.add(command);
        this.#deniedBySession.set(sessionId, commands);
    }
    consumeDenial(sessionId, command) {
        if (!sessionId)
            return false;
        const commands = this.#deniedBySession.get(sessionId);
        if (!commands?.delete(command))
            return false;
        if (commands.size === 0)
            this.#deniedBySession.delete(sessionId);
        return true;
    }
    hasDenial(sessionId, command) {
        if (!sessionId)
            return false;
        return this.#deniedBySession.get(sessionId)?.has(command) ?? false;
    }
    requiresApproval(sessionId, command) {
        return requestsDockerHostControl(command) || this.hasDenial(sessionId, command);
    }
    configure(settings) {
        this.#settings = settings;
    }
    grant({ command, cwd, scope, sessionId }) {
        if (scope === 'once') {
            const commands = this.#onceBySession.get(sessionId) ?? new Set();
            commands.add(command);
            this.#onceBySession.set(sessionId, commands);
        }
        if (scope === 'session') {
            const roots = this.#sessionRootsBySession.get(sessionId) ?? new Set();
            roots.add(realRoot(cwd));
            this.#sessionRootsBySession.set(sessionId, roots);
        }
        if (scope === 'project')
            this.grantProject(cwd);
    }
    consumeOnce(sessionId, command) {
        const commands = this.#onceBySession.get(sessionId);
        if (!commands?.delete(command))
            return false;
        if (commands.size === 0)
            this.#onceBySession.delete(sessionId);
        return true;
    }
    hasSession(sessionId, cwd) {
        return this.#sessionRootsBySession.get(sessionId)?.has(realRoot(cwd)) ?? false;
    }
    hasProject(cwd) {
        return (this.#settings?.get('sandbox.dockerHostControlProjects') ?? []).includes(realRoot(cwd));
    }
    grantProject(cwd) {
        const root = realRoot(cwd);
        if (!this.#settings)
            throw new Error('Docker host-control grants are not configured.');
        const projects = this.#settings.get('sandbox.dockerHostControlProjects') ?? [];
        if (!projects.includes(root))
            this.#settings.set('sandbox.dockerHostControlProjects', [...projects, root]);
    }
    clearSession(sessionId) {
        this.#onceBySession.delete(sessionId);
        this.#sessionRootsBySession.delete(sessionId);
        this.#deniedBySession.delete(sessionId);
    }
    resetForTests() {
        this.#onceBySession.clear();
        this.#sessionRootsBySession.clear();
        this.#deniedBySession.clear();
        this.#settings = undefined;
    }
}
const dockerHostControlGrants = new DockerHostControlGrants();
export const configureDockerHostControlGrants = (settings) => dockerHostControlGrants.configure(settings);
export const grantDockerHostControl = (grant) => dockerHostControlGrants.grant(grant);
export const consumeDockerHostControlOnce = (sessionId, command) => dockerHostControlGrants.consumeOnce(sessionId, command);
export const hasDockerHostControlSession = (sessionId, cwd) => dockerHostControlGrants.hasSession(sessionId, cwd);
export const hasDockerHostControlProject = (cwd) => dockerHostControlGrants.hasProject(cwd);
export const clearDockerHostControlSession = (sessionId) => dockerHostControlGrants.clearSession(sessionId);
export const recordDockerHostControlDenial = (sessionId, command) => dockerHostControlGrants.recordDenial(sessionId, command);
export const consumeDockerHostControlDenial = (sessionId, command) => dockerHostControlGrants.consumeDenial(sessionId, command);
/**
 * Whether this command must go through the Docker host-control approval prompt:
 * either it reads as a Docker invocation, or a sandboxed run of it in *this*
 * session was already blocked from the daemon (the only signal for indirect
 * invocations).
 *
 * Every caller that decides approval must pass the same session, or the prompt
 * and the execution disagree about Docker and the command stalls on approval.
 * The UI cannot see a session, so it must not call this — see
 * `ApprovalDescriptor.dockerHostControl`, resolved by the producer that can.
 */
export const requiresDockerHostControlApproval = (sessionId, command) => requestsDockerHostControl(command) || dockerHostControlGrants.hasDenial(sessionId, command);
export const resetDockerHostControlGrantsForTests = () => dockerHostControlGrants.resetForTests();
//# sourceMappingURL=docker-host-control-grants.js.map