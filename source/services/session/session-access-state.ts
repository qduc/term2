import fs from 'node:fs';
import path from 'node:path';
import type { ISettingsService } from '../service-interfaces.js';
import { requestsDockerHostControl } from '../../utils/shell/sandbox/docker-host-control.js';

export type DockerHostControlGrant = 'once' | 'session' | 'project';

/** Session-bound read and Docker state; project Docker grants stay in settings. */
export class SessionAccessState {
  readonly #readFolders = new Set<string>();
  readonly #editFiles = new Set<string>();
  readonly #editFolders = new Set<string>();
  readonly #dockerOnce = new Set<string>();
  readonly #dockerRoots = new Set<string>();
  readonly #dockerDenials = new Set<string>();

  constructor(private readonly settings: ISettingsService) {}

  allowReadFolder(folder: string): void {
    this.#readFolders.add(folder);
  }

  allowsRead(targetPath: string, baseDir: string = process.cwd()): boolean {
    const target = path.resolve(baseDir, targetPath);
    return [...this.#readFolders].some((folder) => {
      const resolvedFolder = path.resolve(baseDir, folder);
      return target === resolvedFolder || target.startsWith(`${resolvedFolder}${path.sep}`);
    });
  }

  allowEditFile(file: string, baseDir: string = process.cwd()): void {
    this.#editFiles.add(path.resolve(baseDir, file));
  }

  allowEditFolder(folder: string, baseDir: string = process.cwd()): void {
    this.#editFolders.add(path.resolve(baseDir, folder));
  }

  allowsEdit(targetPath: string, baseDir: string = process.cwd()): boolean {
    const target = path.resolve(baseDir, targetPath);
    return (
      this.#editFiles.has(target) ||
      [...this.#editFolders].some((folder) => target === folder || target.startsWith(`${folder}${path.sep}`))
    );
  }

  requiresDockerApproval(command: string): boolean {
    return requestsDockerHostControl(command) || this.#dockerDenials.has(command);
  }

  grantDocker(command: string, cwd: string, scope: DockerHostControlGrant): void {
    if (scope === 'once') this.#dockerOnce.add(command);
    if (scope === 'session') this.#dockerRoots.add(realRoot(cwd));
    if (scope === 'project') this.#grantDockerProject(cwd);
  }

  hasDockerGrant(command: string, cwd: string): boolean {
    return this.hasDockerProject(cwd) || this.#dockerRoots.has(realRoot(cwd)) || this.#dockerOnce.delete(command);
  }

  hasDockerSessionGrant(cwd: string): boolean {
    return this.#dockerRoots.has(realRoot(cwd));
  }

  hasDockerProject(cwd: string): boolean {
    return (this.settings.get('sandbox.dockerHostControlProjects') ?? []).includes(realRoot(cwd));
  }

  recordDockerDenial(command: string): void {
    this.#dockerDenials.add(command);
  }

  consumeDockerDenial(command: string): boolean {
    return this.#dockerDenials.delete(command);
  }

  /** Clears state that must not survive a reset or imported conversation. */
  clearTransient(): void {
    this.#readFolders.clear();
    this.#editFiles.clear();
    this.#editFolders.clear();
    this.#dockerOnce.clear();
    this.#dockerRoots.clear();
    this.#dockerDenials.clear();
  }

  dispose(): void {
    this.clearTransient();
  }

  #grantDockerProject(cwd: string): void {
    const root = realRoot(cwd);
    const projects = this.settings.get('sandbox.dockerHostControlProjects') ?? [];
    if (!projects.includes(root)) this.settings.set('sandbox.dockerHostControlProjects', [...projects, root]);
  }
}

const realRoot = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};
