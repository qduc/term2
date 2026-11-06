import fs from 'node:fs';
import path from 'node:path';
import { resolveGlobSearchTarget } from '../../tools/file/glob-target.js';

/**
 * The folder a "allow for this session" answer should grant, or null when the
 * arguments carry no usable target. read_file names a file, so its folder is the
 * parent; grep and glob name a directory unless the target is an existing file.
 */
export function resolveSessionReadFolder(toolName: string | undefined, args: unknown): string | null {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  const rawPath = typeof record?.path === 'string' ? record.path.trim() : '';

  if (toolName === 'read_file') {
    return rawPath ? path.dirname(rawPath) : null;
  }

  if (toolName === 'grep') {
    return rawPath ? folderOf(rawPath) : null;
  }

  if (toolName === 'glob') {
    const rawPattern = typeof record?.pattern === 'string' ? record.pattern : undefined;
    const { targetPath } = resolveGlobSearchTarget(rawPattern, rawPath || undefined);
    return targetPath && targetPath !== '.' ? folderOf(targetPath) : null;
  }

  return null;
}

/** A path that is an existing file grants its parent; anything else grants itself. */
function folderOf(target: string): string {
  try {
    if (fs.statSync(target).isFile()) return path.dirname(target);
  } catch {
    // Unreadable or non-existent: treat it as the directory the user approved.
  }
  return target;
}
