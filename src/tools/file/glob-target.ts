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
): { pattern: string; targetPath: string; directChildrenOnly: boolean } {
  let pattern = (rawPattern ?? '').trim();
  let targetPath = searchPath?.trim() || '.';
  let directChildrenOnly = false;

  const normalizedPattern = pattern.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedPattern)) {
    // Only use the pattern's directory as search root if no explicit path was given.
    if (!searchPath?.trim()) {
      targetPath = path.dirname(normalizedPattern);
    }
    pattern = path.basename(normalizedPattern);
  } else {
    // A relative pattern whose leading literal directory part climbs with `..` carries its own search root too:
    // `../*.txt` searches the parent for `*.txt`, it is not a name pattern for the workspace. Splitting it off here
    // makes approval see the directory that is read, as for an absolute pattern.
    const segments = normalizedPattern.split('/');
    let literal = 0;
    while (literal < segments.length - 1 && segments[literal] !== '' && !/[*?[\]{}]/.test(segments[literal]!)) {
      literal++;
    }
    const directory = segments.slice(0, literal);
    if (directory.includes('..')) {
      targetPath = path.join(targetPath, ...directory);
      pattern = segments.slice(literal).join('/');
      // `../*.txt` names the parent's own files, not every `.txt` below it.
      directChildrenOnly = !pattern.includes('/');
    }
  }

  return { pattern, targetPath, directChildrenOnly };
}
