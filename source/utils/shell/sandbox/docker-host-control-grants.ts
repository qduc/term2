import fs from 'node:fs';
import path from 'node:path';
import type { ISettingsService } from '../../../services/service-interfaces.js';

export type DockerHostControlGrant = 'once' | 'session' | 'project';

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
  #once = new Set<string>();
  #sessionRoots = new Set<string>();

  configure(settings: ISettingsService): void {
    this.#settings = settings;
  }

  grant({ command, cwd, scope }: { command: string; cwd: string; scope: DockerHostControlGrant }): void {
    if (scope === 'once') this.#once.add(command);
    if (scope === 'session') this.#sessionRoots.add(realRoot(cwd));
    if (scope === 'project') this.grantProject(cwd);
  }
  consumeOnce(command: string): boolean {
    return this.#once.delete(command);
  }
  hasSession(cwd: string): boolean {
    return this.#sessionRoots.has(realRoot(cwd));
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
  clearSession(): void {
    this.#sessionRoots.clear();
  }
  resetForTests(): void {
    this.#once.clear();
    this.#sessionRoots.clear();
    this.#settings = undefined;
  }
}

const dockerHostControlGrants = new DockerHostControlGrants();
export const configureDockerHostControlGrants = (settings: ISettingsService) =>
  dockerHostControlGrants.configure(settings);
export const grantDockerHostControl = (grant: { command: string; cwd: string; scope: DockerHostControlGrant }) =>
  dockerHostControlGrants.grant(grant);
export const consumeDockerHostControlOnce = (command: string) => dockerHostControlGrants.consumeOnce(command);
export const hasDockerHostControlSession = (cwd: string) => dockerHostControlGrants.hasSession(cwd);
export const hasDockerHostControlProject = (cwd: string) => dockerHostControlGrants.hasProject(cwd);
export const clearDockerHostControlSession = () => dockerHostControlGrants.clearSession();
export const resetDockerHostControlGrantsForTests = () => dockerHostControlGrants.resetForTests();
export const normalizeDockerHostControlWorkspaceRoot = realRoot;
