import fs from 'node:fs';
import path from 'node:path';
import type { ISettingsService } from '../../../services/service-interfaces.js';
import { requestsDockerHostControl } from './docker-host-control.js';

export type DockerHostControlGrant = 'once' | 'session' | 'project';

type DockerHostControlGrantRequest = {
  command: string;
  cwd: string;
  scope: DockerHostControlGrant;
  sessionId: string;
};

const realRoot = (cwd: string) => {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

/** Narrow capability grant store. Persistence is intentionally limited to user settings. */
export class DockerHostControlGrants {
  #settings: ISettingsService | undefined;
  #onceBySession = new Map<string, Set<string>>();
  #sessionRootsBySession = new Map<string, Set<string>>();
  #deniedBySession = new Map<string, Set<string>>();

  /**
   * A sandboxed run of this command was blocked from the Docker daemon.
   *
   * Scoped to the session that hit the block: the record is what later grants a
   * command host control, so another session must not inherit it. A run with no
   * session identity cannot be attributed, so it is dropped rather than recorded
   * globally — the command stays sandboxed instead of gaining unearned access.
   */
  recordDenial(sessionId: string | undefined, command: string): void {
    if (!sessionId) return;
    const commands = this.#deniedBySession.get(sessionId) ?? new Set<string>();
    commands.add(command);
    this.#deniedBySession.set(sessionId, commands);
  }

  consumeDenial(sessionId: string | undefined, command: string): boolean {
    if (!sessionId) return false;
    const commands = this.#deniedBySession.get(sessionId);
    if (!commands?.delete(command)) return false;
    if (commands.size === 0) this.#deniedBySession.delete(sessionId);
    return true;
  }

  hasDenial(sessionId: string | undefined, command: string): boolean {
    if (!sessionId) return false;
    return this.#deniedBySession.get(sessionId)?.has(command) ?? false;
  }

  requiresApproval(sessionId: string | undefined, command: string): boolean {
    return requestsDockerHostControl(command) || this.hasDenial(sessionId, command);
  }

  configure(settings: ISettingsService): void {
    this.#settings = settings;
  }

  grant({ command, cwd, scope, sessionId }: DockerHostControlGrantRequest): void {
    if (scope === 'once') {
      const commands = this.#onceBySession.get(sessionId) ?? new Set<string>();
      commands.add(command);
      this.#onceBySession.set(sessionId, commands);
    }
    if (scope === 'session') {
      const roots = this.#sessionRootsBySession.get(sessionId) ?? new Set<string>();
      roots.add(realRoot(cwd));
      this.#sessionRootsBySession.set(sessionId, roots);
    }
    if (scope === 'project') this.grantProject(cwd);
  }

  consumeOnce(sessionId: string, command: string): boolean {
    const commands = this.#onceBySession.get(sessionId);
    if (!commands?.delete(command)) return false;
    if (commands.size === 0) this.#onceBySession.delete(sessionId);
    return true;
  }

  hasSession(sessionId: string, cwd: string): boolean {
    return this.#sessionRootsBySession.get(sessionId)?.has(realRoot(cwd)) ?? false;
  }

  hasProject(cwd: string): boolean {
    return (this.#settings?.get<string[]>('sandbox.dockerHostControlProjects') ?? []).includes(realRoot(cwd));
  }

  grantProject(cwd: string): void {
    const root = realRoot(cwd);
    if (!this.#settings) throw new Error('Docker host-control grants are not configured.');
    const projects = this.#settings.get<string[]>('sandbox.dockerHostControlProjects') ?? [];
    if (!projects.includes(root)) this.#settings.set('sandbox.dockerHostControlProjects', [...projects, root]);
  }

  clearSession(sessionId: string): void {
    this.#onceBySession.delete(sessionId);
    this.#sessionRootsBySession.delete(sessionId);
    this.#deniedBySession.delete(sessionId);
  }

  resetForTests(): void {
    this.#onceBySession.clear();
    this.#sessionRootsBySession.clear();
    this.#deniedBySession.clear();
    this.#settings = undefined;
  }
}

const dockerHostControlGrants = new DockerHostControlGrants();
export const configureDockerHostControlGrants = (settings: ISettingsService) => dockerHostControlGrants.configure(settings);
export const grantDockerHostControl = (grant: DockerHostControlGrantRequest) => dockerHostControlGrants.grant(grant);
export const consumeDockerHostControlOnce = (sessionId: string, command: string) => dockerHostControlGrants.consumeOnce(sessionId, command);
export const hasDockerHostControlSession = (sessionId: string, cwd: string) => dockerHostControlGrants.hasSession(sessionId, cwd);
export const hasDockerHostControlProject = (cwd: string) => dockerHostControlGrants.hasProject(cwd);
export const clearDockerHostControlSession = (sessionId: string) => dockerHostControlGrants.clearSession(sessionId);
export const recordDockerHostControlDenial = (sessionId: string | undefined, command: string) => dockerHostControlGrants.recordDenial(sessionId, command);
export const consumeDockerHostControlDenial = (sessionId: string | undefined, command: string) => dockerHostControlGrants.consumeDenial(sessionId, command);
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
export const normalizeDockerHostControlWorkspaceRoot = realRoot;
export const requiresDockerHostControlApproval = (sessionId: string | undefined, command: string) => requestsDockerHostControl(command) || dockerHostControlGrants.hasDenial(sessionId, command);
export const resetDockerHostControlGrantsForTests = () => dockerHostControlGrants.resetForTests();
