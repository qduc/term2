import path from 'node:path';

/** Session-scoped allowlist for read-only access outside the workspace. */
export class SessionReadAccess {
  readonly #foldersBySession = new Map<string, Set<string>>();

  allowFolder(sessionId: string, folder: string): void {
    const folders = this.#foldersBySession.get(sessionId) ?? new Set<string>();
    folders.add(folder);
    this.#foldersBySession.set(sessionId, folders);
  }

  allows(sessionId: string, targetPath: string, baseDir: string = process.cwd()): boolean {
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

export function getSessionIdFromToolContext(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const runContext = context as { context?: unknown };
  if (!runContext.context || typeof runContext.context !== 'object') return null;
  const sessionId = (runContext.context as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}
