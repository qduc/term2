import fs from 'node:fs';
import { canonicalPath, isPathWithin } from '../../tools/path-identity.js';
import { getActiveWorkspaceRoot } from '../../tools/workspace/active-workspace-root.js';
import path from 'node:path';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import { requestsDockerHostControl } from '../../tools/shell/sandbox/docker-host-control.js';
import type { FileReadAccessPort, FileEditAccessPort, ShellAccessPort } from '../../tools/access-port.js';

export type DockerHostControlGrant = 'once' | 'session' | 'project';

/** Session-bound read and Docker state; project Docker grants stay in settings. */
export class SessionAccessState implements FileReadAccessPort, FileEditAccessPort, ShellAccessPort {
  readonly #readFolders = new Set<string>();
  readonly #editFiles = new Set<string>();
  readonly #editFolders = new Set<string>();
  readonly #createdFiles = new Set<string>();
  readonly #dockerOnce = new Set<string>();
  readonly #dockerRoots = new Set<string>();
  readonly #dockerDenials = new Set<string>();

  constructor(
    private readonly settings: ISettingsService,
    private readonly options: { allowEdit?: boolean; isRemote?: () => boolean } = {},
  ) {}

  /** Grants are stored and matched under one identity (src/tools/path-identity.ts). */
  #identity(target: string, baseDir: string): string {
    return canonicalPath(target, baseDir, { remote: this.options.isRemote?.() ?? false });
  }

  get isReadOnly(): boolean {
    return this.options.allowEdit === false;
  }

  recordCreatedFile(file: string, baseDir: string = getActiveWorkspaceRoot()): void {
    this.#createdFiles.add(this.#identity(file, baseDir));
  }

  isCreatedInSession(targetPath: string, baseDir: string = getActiveWorkspaceRoot()): boolean {
    return this.#createdFiles.has(this.#identity(targetPath, baseDir));
  }

  removeCreatedFile(file: string, baseDir: string = getActiveWorkspaceRoot()): void {
    this.#createdFiles.delete(this.#identity(file, baseDir));
  }

  allowReadFolder(folder: string, baseDir: string = getActiveWorkspaceRoot()): void {
    this.#readFolders.add(this.#identity(folder, baseDir));
  }

  allowsRead(targetPath: string, baseDir: string = getActiveWorkspaceRoot()): boolean {
    const target = this.#identity(targetPath, baseDir);
    return [...this.#readFolders].some((folder) => isPathWithin(target, folder));
  }

  allowEditFile(file: string, baseDir: string = getActiveWorkspaceRoot()): void {
    this.#editFiles.add(this.#identity(file, baseDir));
  }

  allowEditFolder(folder: string, baseDir: string = getActiveWorkspaceRoot()): void {
    this.#editFolders.add(this.#identity(folder, baseDir));
  }

  allowsEdit(targetPath: string, baseDir: string = getActiveWorkspaceRoot()): boolean {
    if (this.options.allowEdit === false) return false;
    const target = this.#identity(targetPath, baseDir);
    return this.#editFiles.has(target) || [...this.#editFolders].some((folder) => isPathWithin(target, folder));
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
    this.#createdFiles.clear();
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
