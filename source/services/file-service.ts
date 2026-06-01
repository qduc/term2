import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';
import { default as createIgnore, type Ignore } from 'ignore';

export type PathEntry = {
  path: string;
  type: 'file' | 'directory';
};

export type WorkspaceEntriesMeta = {
  lastLoadedAt: number | null;
  totalEntries: number;
  truncated: boolean;
  truncatedByTotalLimit: boolean;
  limit: number;
};

export type WorkspaceEntryScanOptions = {
  maxDepth?: number;
  maxTotalEntries?: number;
  includeFiles?: boolean;
};

export type WorkspaceEntryScanResult = {
  entries: PathEntry[];
  truncated: boolean;
  truncatedByTotalLimit: boolean;
};

const workspaceRoot = process.cwd();
const DEFAULT_IGNORES = ['.git/**'];
const GITIGNORE_NAME = '.gitignore';
const MAX_SCAN_DEPTH = 25;
export const WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT = 10_000;

let cachedEntries: PathEntry[] | null = null;
let lastLoadedAt: number | null = null;
let lastLoadTruncated = false;
let lastLoadTruncatedByTotalLimit = false;

const normalizePath = (entryPath: string): string => entryPath.replaceAll(path.sep, '/');

// Resolve the target type of a symlink without traversing it. Symlinks are
// listed in completion results (matching the previous fast-glob behavior) but
// never descended into, to avoid traversal cycles.
const resolveSymlinkType = async (absolutePath: string): Promise<PathEntry['type']> => {
  try {
    const stats = await fs.stat(absolutePath);
    return stats.isDirectory() ? 'directory' : 'file';
  } catch {
    // Broken symlink (dangling target): treat as a file so it remains listable.
    return 'file';
  }
};

const createIgnoreMatcher = async (cwd: string): Promise<Ignore> => {
  const matcher = (createIgnore as unknown as () => Ignore)();
  matcher.add(DEFAULT_IGNORES);

  const gitignorePath = path.join(cwd, GITIGNORE_NAME);

  try {
    const gitignoreContents = await fs.readFile(gitignorePath, 'utf8');
    matcher.add(gitignoreContents);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Avoid importing the deprecated loggingService singleton here.
      // This is a non-critical warning; console output is sufficient.
      console.warn('[file-service] Failed to read .gitignore', {
        error: error instanceof Error ? error.message : String(error),
        path: gitignorePath,
      });
    }
  }

  return matcher;
};

const sortDirEntries = (entries: Dirent[]): Dirent[] =>
  entries.slice().sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

const loadDirectoryEntries = async (
  cwd: string,
  options: WorkspaceEntryScanOptions = {},
): Promise<WorkspaceEntryScanResult> => {
  const matcher = await createIgnoreMatcher(cwd);
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const maxTotalEntries = options.maxTotalEntries ?? WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT;
  const includeFiles = options.includeFiles ?? true;

  const queue: Array<{ dir: string; relativePath: string; depth: number }> = [{ dir: cwd, relativePath: '', depth: 0 }];
  const entries: PathEntry[] = [];
  let truncatedByTotalLimit = false;

  // Children are only enqueued while current.depth < maxDepth, so a queued node
  // can never exceed maxDepth; the only reason to stop draining the queue is the
  // total-entry cap.
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (entries.length >= maxTotalEntries) {
      truncatedByTotalLimit = true;
      continue;
    }

    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const filtered = sortDirEntries(dirEntries).filter((entry) => {
      if (entry.name.length === 0) return false;
      if (!includeFiles && !entry.isDirectory()) return false;

      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      const ignoredPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      return !matcher.ignores(ignoredPath);
    });

    for (let entryIndex = 0; entryIndex < filtered.length; entryIndex++) {
      if (entries.length >= maxTotalEntries) {
        truncatedByTotalLimit = true;
        break;
      }

      const entry = filtered[entryIndex];
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      const normalizedPath = normalizePath(relativePath);
      const absolutePath = path.join(current.dir, entry.name);

      const type: PathEntry['type'] = entry.isSymbolicLink()
        ? await resolveSymlinkType(absolutePath)
        : entry.isDirectory()
        ? 'directory'
        : 'file';

      entries.push({ path: normalizedPath, type });

      // Only descend into real directories (entry.isDirectory() is false for
      // symlinks), so symlinked directories are listed but never traversed.
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({
          dir: absolutePath,
          relativePath: normalizedPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  return {
    entries,
    truncated: truncatedByTotalLimit,
    truncatedByTotalLimit,
  };
};

const loadWorkspaceEntries = async (): Promise<PathEntry[]> => {
  const result = await loadDirectoryEntries(workspaceRoot);
  lastLoadTruncated = result.truncated;
  lastLoadTruncatedByTotalLimit = result.truncatedByTotalLimit;

  return result.entries;
};

export const scanWorkspaceEntries = async (
  cwd: string,
  options: WorkspaceEntryScanOptions = {},
): Promise<WorkspaceEntryScanResult> => loadDirectoryEntries(cwd, options);

export const getWorkspaceEntries = async (): Promise<PathEntry[]> => {
  if (!cachedEntries) {
    cachedEntries = await loadWorkspaceEntries();
    lastLoadedAt = Date.now();
  }

  return cachedEntries;
};

export const refreshWorkspaceEntries = async (): Promise<PathEntry[]> => {
  cachedEntries = null;
  return getWorkspaceEntries();
};

export const getWorkspaceRoot = (): string => workspaceRoot;

export const getWorkspaceEntriesMeta = (): WorkspaceEntriesMeta => ({
  lastLoadedAt,
  totalEntries: cachedEntries?.length ?? 0,
  truncated: lastLoadTruncated,
  truncatedByTotalLimit: lastLoadTruncatedByTotalLimit,
  limit: WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT,
});
