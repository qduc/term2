import path from 'node:path';

/**
 * An absolute `pattern` carries its own search root, so the directory the glob
 * tool actually reads is not always `params.path`. Approval, the session grant
 * and execution must all agree on the target, so they share this derivation.
 *
 * Kept dependency-free so the approval UI can import it.
 */
export function resolveGlobSearchTarget(
  rawPattern: string | undefined,
  searchPath: string | undefined,
): { pattern: string; targetPath: string } {
  let pattern = (rawPattern ?? '').trim();
  let targetPath = searchPath?.trim() || '.';

  const normalizedPattern = pattern.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedPattern)) {
    // Only use the pattern's directory as search root if no explicit path was given.
    if (!searchPath?.trim()) {
      targetPath = path.dirname(normalizedPattern);
    }
    pattern = path.basename(normalizedPattern);
  }

  return { pattern, targetPath };
}
