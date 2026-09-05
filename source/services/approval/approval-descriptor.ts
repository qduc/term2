import path from 'node:path';
import { homedir } from 'node:os';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';

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
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined;
  const operation = Array.isArray(record?.operations) ? record.operations[0] : record;
  const rawPath = operation && typeof operation === 'object' ? (operation as Record<string, unknown>).path : undefined;
  if (typeof rawPath !== 'string') return undefined;

  const resolvedRoot = path.resolve(workspaceRoot);
  const expandedPath = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const target = path.isAbsolute(expandedPath)
    ? path.normalize(expandedPath)
    : path.resolve(resolvedRoot, expandedPath);
  if (target === resolvedRoot || target.startsWith(`${resolvedRoot}${path.sep}`)) return undefined;
  return { path: target, folder: path.dirname(target) };
}
