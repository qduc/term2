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
class DockerHostControlGrants {
  #settings: ISettingsService | undefined;
  #onceBySession = new Map<string, Set<string>>();
  #sessionRootsBySession = new Map<string, Set<string>>();
  #deniedCommands = new Set<string>();

  /** A sandboxed run of this command was blocked from the Docker daemon. */
  recordDenial(command: string): void {
    this.#deniedCommands.add(command);
  }

  consumeDenial(command: string): boolean {
    return this.#deniedCommands.delete(command);
  }

  hasDenial(command: string): boolean {
    return this.#deniedCommands.has(command);
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
    if (!this.#settings) throw new Error('Docker host-control grants are not configured.');
    const root = realRoot(cwd);
    const projects = this.#settings.get<string[]>('sandbox.dockerHostControlProjects') ?? [];
    if (!projects.includes(root)) this.#settings.set('sandbox.dockerHostControlProjects', [...projects, root]);
  }

  clearSession(sessionId: string): void {
    this.#onceBySession.delete(sessionId);
    this.#sessionRootsBySession.delete(sessionId);
  }

  resetForTests(): void {
    this.#onceBySession.clear();
    this.#sessionRootsBySession.clear();
    this.#deniedCommands.clear();
    this.#settings = undefined;
  }
}

const dockerHostControlGrants = new DockerHostControlGrants();
export const configureDockerHostControlGrants = (settings: ISettingsService) =>
  dockerHostControlGrants.configure(settings);
export const grantDockerHostControl = (grant: DockerHostControlGrantRequest) => dockerHostControlGrants.grant(grant);
export const consumeDockerHostControlOnce = (sessionId: string, command: string) =>
  dockerHostControlGrants.consumeOnce(sessionId, command);
export const hasDockerHostControlSession = (sessionId: string, cwd: string) =>
  dockerHostControlGrants.hasSession(sessionId, cwd);
export const hasDockerHostControlProject = (cwd: string) => dockerHostControlGrants.hasProject(cwd);
export const clearDockerHostControlSession = (sessionId: string) => dockerHostControlGrants.clearSession(sessionId);
export const recordDockerHostControlDenial = (command: string) => dockerHostControlGrants.recordDenial(command);
export const consumeDockerHostControlDenial = (command: string) => dockerHostControlGrants.consumeDenial(command);

/**
 * Whether this command must go through the Docker host-control approval prompt:
 * either it reads as a Docker invocation, or a sandboxed run of it was already
 * blocked from the daemon (the only signal for indirect invocations).
 */
export const requiresDockerHostControlApproval = (command: string) =>
  requestsDockerHostControl(command) || dockerHostControlGrants.hasDenial(command);
export const resetDockerHostControlGrantsForTests = () => dockerHostControlGrants.resetForTests();
export const normalizeDockerHostControlWorkspaceRoot = realRoot;
