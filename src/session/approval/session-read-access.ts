import path from 'node:path';
import { getActiveWorkspaceRoot } from '../../tools/workspace/active-workspace-root.js';
export { isSessionReadGranted } from '../../tools/file/read-access.js';

/** Session-scoped allowlist for read-only access outside the workspace. */
export class SessionReadAccess {
  readonly #foldersBySession = new Map<string, Set<string>>();

  allowFolder(sessionId: string, folder: string): void {
    const folders = this.#foldersBySession.get(sessionId) ?? new Set<string>();
    folders.add(folder);
    this.#foldersBySession.set(sessionId, folders);
  }

  allows(sessionId: string, targetPath: string, baseDir: string = getActiveWorkspaceRoot()): boolean {
    const folders = this.#foldersBySession.get(sessionId);
    if (!folders) return false;

    const target = path.resolve(baseDir, targetPath);
    return [...folders].some((folder) => {
      const resolvedFolder = path.resolve(baseDir, folder);
      return target === resolvedFolder || target.startsWith(`${resolvedFolder}${path.sep}`);
    });
  }

  clear(sessionId: string): void {
    this.#foldersBySession.delete(sessionId);
  }
}

export const sessionReadAccess = new SessionReadAccess();
