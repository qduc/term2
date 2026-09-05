import path from 'node:path';
import { homedir } from 'node:os';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { extractToolTargetPaths } from './shell-auto-approval-resolver.js';

/**
 * Computes the authority metadata used by both provider approval prompts and
 * nested run_code prompts. The caller supplies the root that prepared the
 * tool call so relative paths cannot silently fall back to process.cwd().
 */
export function resolveOutsideWorkspaceEdit(
  toolName: string | undefined,
  args: unknown,
  workspaceRoot: string = getActiveWorkspaceRoot(),
): { path: string; folder: string } | undefined {
  if (toolName !== 'apply_patch' && toolName !== 'create_file' && toolName !== 'search_replace') return undefined;
  const targets = extractToolTargetPaths(toolName, args);
  const resolvedRoot = path.resolve(workspaceRoot);
  const target = targets
    .map((rawPath) => {
      const expandedPath = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
      return path.isAbsolute(expandedPath) ? path.normalize(expandedPath) : path.resolve(resolvedRoot, expandedPath);
    })
    .find((candidate) => candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep));
  return target ? { path: target, folder: path.dirname(target) } : undefined;
}
