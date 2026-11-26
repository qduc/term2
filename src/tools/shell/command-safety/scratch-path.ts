import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../../../shared/utils/shell/temp-dir.js';

/**
 * Path text in a shell command as the safety checks should see it.
 *
 * The shell tool gives every child `TMPDIR=SANDBOX_TEMP_DIR`, sandboxed or not
 * (`resolveChildTmpDir`, `createSandboxEnvironment`), and the prompt tells the
 * model to put scratch files in `$TMPDIR`. The checks must therefore read
 * `$TMPDIR/x` as that directory, not as a relative path named `$TMPDIR` inside
 * the workspace: that misreading made `rm "$TMPDIR/verify.mjs"` RED, and a RED
 * shell command is denied before any reviewer sees it.
 *
 * Expansion is skipped when the value at run time is not known: the command
 * mentions `TMPDIR` other than as a plain `$TMPDIR` / `${TMPDIR}` reference
 * (an assignment, `export`, `unset`, `${TMPDIR:-…}`), or it runs code the
 * classifier cannot see (`source`, `.`, `eval`).
 */
export function createScratchPathResolver(commandString: string): (text: string | undefined) => string | undefined {
  const withoutReferences = commandString.replace(/\$\{TMPDIR\}|\$TMPDIR(?![A-Za-z0-9_])/g, '');
  const runsUnseenCode = /(?:^|[\s;&|(){}`])(?:source|\.|eval)(?=\s)/.test(commandString);
  const tmpdirIsKnown = !/TMPDIR/.test(withoutReferences) && !runsUnseenCode;
  return (text) => {
    if (text === undefined) return undefined;
    const expanded = tmpdirIsKnown ? expandTmpdir(text) : text;
    return canonicalScratchSpelling(expanded);
  };
}

function expandTmpdir(text: string): string {
  const match = /^(?:\$\{TMPDIR\}|\$TMPDIR(?![A-Za-z0-9_]))(?=\/|$)/.exec(text);
  return match ? SANDBOX_TEMP_DIR + text.slice(match[0].length) : text;
}

/**
 * On macOS `SANDBOX_TEMP_DIR` is a realpath under `/private/var/folders`, while
 * commands often spell it `/var/folders/...`; `/var` is a system path to the
 * checks. Rewrite only spellings that land inside the scratch directory.
 */
const SCRATCH_ALIAS = SANDBOX_TEMP_DIR.startsWith('/private/') ? SANDBOX_TEMP_DIR.slice('/private'.length) : undefined;

function canonicalScratchSpelling(text: string): string {
  if (!SCRATCH_ALIAS || !path.isAbsolute(text)) return text;
  const normalized = path.normalize(text);
  if (normalized === SCRATCH_ALIAS || normalized.startsWith(SCRATCH_ALIAS + path.sep)) {
    return SANDBOX_TEMP_DIR + normalized.slice(SCRATCH_ALIAS.length);
  }
  return text;
}

/**
 * True when `resolved` (output of the resolver) is a concrete path inside the scratch area. The shell still
 * expands what the classifier sees as text: a remaining `$`, backtick, brace or glob, or a `..` segment, can
 * name any path once expanded (`$TMPDIR/$X/…`, `$TMPDIR/{a,..}/…`, `$TMPDIR/.?/…`), so such text never counts.
 */
export function isConcreteScratchPath(resolved: string): boolean {
  if (/[$`{}*?[\]\\]/.test(resolved)) return false;
  if (resolved.split('/').includes('..')) return false;
  const normalized = path.normalize(resolved);
  return normalized === SANDBOX_TEMP_DIR || normalized.startsWith(SANDBOX_TEMP_DIR + path.sep);
}
