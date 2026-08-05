import { lstat as fsLstat, readdir as fsReaddir, realpath as fsRealpath } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';

import type { HookDiagnostic } from './hook-registry.js';

export type HookFileScope = 'user' | 'project';

export interface DiscoveredHookFile {
  readonly path: string;
  readonly scope: HookFileScope;
  readonly root: string;
}

export interface HookDiscoveryResult {
  readonly files: readonly DiscoveredHookFile[];
  readonly userRoot?: string;
  readonly projectRoot?: string;
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookDiscoveryFileSystem {
  readonly lstat: (path: string) => Promise<Pick<Stats, 'isDirectory' | 'isFile' | 'isSymbolicLink'>>;
  readonly realpath: (path: string) => Promise<string>;
  readonly readdir: (
    path: string,
    options: { readonly withFileTypes: true },
  ) => Promise<readonly Pick<Dirent, 'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>[]>;
}

const DEFAULT_FILE_SYSTEM: HookDiscoveryFileSystem = {
  lstat: async (path) => fsLstat(path),
  realpath: async (path) => fsRealpath(path),
  readdir: async (path, options) => fsReaddir(path, options),
};

export interface HookDiscoveryOptions {
  /** The process cwd is used when omitted. */
  readonly cwd?: string;
  /** os.homedir() is used when omitted. */
  readonly homeDir?: string;
  readonly userEnabled?: boolean;
  readonly projectEnabled?: boolean;
  /** Canonical project roots trusted to execute project hooks. */
  readonly trustedProjectRoots?: readonly string[];
  readonly fileSystem?: HookDiscoveryFileSystem;
}

const HOOK_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Finds executable hook files without following symlinks. Discovery is kept
 * independent from SettingsService so its trust and executable-code policy is
 * not accidentally inherited by another kind of user-authored file.
 */
export class HookDiscovery {
  readonly #options: HookDiscoveryOptions;
  readonly #fs: HookDiscoveryFileSystem;

  constructor(options: HookDiscoveryOptions = {}) {
    this.#options = options;
    this.#fs = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  }

  async discover(): Promise<HookDiscoveryResult> {
    const files: DiscoveredHookFile[] = [];
    const diagnostics: HookDiagnostic[] = [];
    const seen = new Set<string>();
    let userRoot: string | undefined;
    let projectRoot: string | undefined;

    if (this.#options.userEnabled !== false) {
      const userBase = await this.#canonicalBase(this.#options.homeDir ?? homedir(), 'user', diagnostics);
      if (userBase) {
        userRoot = join(userBase, '.term2', 'hooks');
        await this.#scanRoot(userRoot, 'user', files, diagnostics, seen);
      }
    } else {
      diagnostics.push({
        code: 'hook_disabled',
        message: 'User hooks are disabled',
        source: { scope: 'user' },
      });
    }

    if (this.#options.projectEnabled !== false) {
      const projectBase = await this.#canonicalBase(this.#options.cwd ?? process.cwd(), 'project', diagnostics);
      if (projectBase) {
        projectRoot = join(projectBase, '.term2', 'hooks');
        if (await this.#isTrustedProject(projectBase)) {
          await this.#scanRoot(projectRoot, 'project', files, diagnostics, seen);
        } else {
          diagnostics.push({
            code: 'project_hooks_untrusted',
            message: 'Project hooks were skipped because the canonical project root is not trusted',
            source: { path: projectBase, scope: 'project' },
          });
        }
      }
    } else {
      diagnostics.push({
        code: 'hook_disabled',
        message: 'Project hooks are disabled',
        source: { scope: 'project' },
      });
    }

    return { files, userRoot, projectRoot, diagnostics };
  }

  #canonicalBase(candidate: string, scope: HookFileScope, diagnostics: HookDiagnostic[]): Promise<string | undefined> {
    return this.#canonicalBaseAsync(candidate, scope, diagnostics);
  }

  async #canonicalBaseAsync(
    candidate: string,
    scope: HookFileScope,
    diagnostics: HookDiagnostic[],
  ): Promise<string | undefined> {
    const resolved = resolve(candidate);
    try {
      const stats = await this.#fs.lstat(resolved);
      if (stats.isSymbolicLink()) {
        diagnostics.push({
          code: 'symlink_rejected',
          message: 'Hook base directory symlinks are rejected',
          source: { path: resolved, scope },
        });
        return undefined;
      }
      if (!stats.isDirectory()) {
        diagnostics.push({
          code: 'discovery_failed',
          message: 'Hook base path is not a directory',
          source: { path: resolved, scope },
        });
        return undefined;
      }
      return await this.#fs.realpath(resolved);
    } catch (error) {
      if (isMissing(error)) return undefined;
      diagnostics.push({
        code: 'discovery_failed',
        message: 'Could not canonicalize hook base directory',
        source: { path: resolved, scope },
        error,
      });
      return undefined;
    }
  }

  async #isTrustedProject(canonicalProjectRoot: string): Promise<boolean> {
    const roots = this.#options.trustedProjectRoots ?? [];
    for (const root of roots) {
      const resolved = resolve(root);
      try {
        if ((await this.#fs.realpath(resolved)) === canonicalProjectRoot) return true;
      } catch (error) {
        if (!isMissing(error)) continue;
        // A missing persisted trust entry cannot match an existing canonical
        // cwd, but retaining this comparison makes injected filesystems with
        // virtual paths behave predictably.
        if (resolved === canonicalProjectRoot) return true;
      }
    }
    return false;
  }

  async #scanRoot(
    root: string,
    scope: HookFileScope,
    files: DiscoveredHookFile[],
    diagnostics: HookDiagnostic[],
    seen: Set<string>,
  ): Promise<void> {
    try {
      const parentStats = await this.#fs.lstat(dirname(root));
      if (parentStats.isSymbolicLink()) {
        diagnostics.push({
          code: 'symlink_rejected',
          message: 'Hook directory ancestors are rejected when symlinked',
          source: { path: dirname(root), scope },
        });
        return;
      }
      const rootStats = await this.#fs.lstat(root);
      if (rootStats.isSymbolicLink()) {
        diagnostics.push({
          code: 'symlink_rejected',
          message: 'Hook directory symlinks are rejected',
          source: { path: root, scope },
        });
        return;
      }
      if (!rootStats.isDirectory()) {
        diagnostics.push({
          code: 'discovery_failed',
          message: 'Hook path is not a directory',
          source: { path: root, scope },
        });
        return;
      }
    } catch (error) {
      if (isMissing(error)) return;
      diagnostics.push({
        code: 'discovery_failed',
        message: 'Could not inspect hook directory',
        source: { path: root, scope },
        error,
      });
      return;
    }

    let entries: readonly Pick<Dirent, 'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>[];
    try {
      entries = await this.#fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      diagnostics.push({
        code: 'discovery_failed',
        message: 'Could not scan hook directory',
        source: { path: root, scope },
        error,
      });
      return;
    }

    const sortedEntries = [...entries].sort((left, right) => lexicalCompare(left.name, right.name));
    for (const entry of sortedEntries) {
      const candidate = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: 'symlink_rejected',
          message: 'Symlinked hook files are rejected',
          source: { path: candidate, scope },
        });
        continue;
      }
      if (!entry.isFile() || !HOOK_EXTENSIONS.has(extname(entry.name))) continue;

      try {
        // Re-check with lstat after readdir to avoid following a replacement
        // symlink if a hook directory changes during discovery.
        const stats = await this.#fs.lstat(candidate);
        if (stats.isSymbolicLink()) {
          diagnostics.push({
            code: 'symlink_rejected',
            message: 'Symlinked hook files are rejected',
            source: { path: candidate, scope },
          });
          continue;
        }
        if (!stats.isFile()) continue;
        const canonical = await this.#fs.realpath(candidate);
        if (!isWithin(root, canonical)) {
          diagnostics.push({
            code: 'symlink_rejected',
            message: 'Hook path resolved outside its canonical hook directory',
            source: { path: candidate, scope },
          });
          continue;
        }
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        files.push({ path: canonical, scope, root });
      } catch (error) {
        if (isMissing(error)) continue;
        diagnostics.push({
          code: 'discovery_failed',
          message: 'Could not inspect hook file',
          source: { path: candidate, scope },
          error,
        });
      }
    }
  }
}

export async function discoverHookFiles(options: HookDiscoveryOptions = {}): Promise<HookDiscoveryResult> {
  return new HookDiscovery(options).discover();
}

export const discoverHooks = discoverHookFiles;
