import { spawnSync } from 'child_process';
import { ExecutionContext } from '../services/execution-context.js';

function defaultCheckBinary(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export interface SearchViaShellOptions {
  checkBinary?: (cmd: string) => boolean;
  executionContext?: ExecutionContext;
}

export function getSearchViaShellAddendum(options: SearchViaShellOptions = {}): string {
  const checkBinary = options.checkBinary ?? defaultCheckBinary;
  const isRemote = options.executionContext?.isRemote() ?? false;

  // For remote hosts, we can't synchronously check binary availability.
  // Default to grep/find which are universally available on Unix-like systems.
  const hasRg = isRemote ? false : checkBinary('rg');
  const hasFd = isRemote ? false : checkBinary('fd');

  const header = `### Searching via the shell

Use the \`shell\` tool with the standard CLI binaries.`;

  const textSearch = hasRg
    ? `**For text search**, use \`rg\` (ripgrep). Examples:
- \`rg "pattern" src/\` — basic search, respects \`.gitignore\` by default.
- \`rg -i "pattern" .\` — case-insensitive.
- \`rg --no-ignore "pattern" .\` — when you need to search \`node_modules\`, build output, or anything in \`.gitignore\`.
- \`rg -uu "pattern" .\` — include hidden + gitignored.
- \`rg -g '*.ts' "pattern" .\` — restrict by glob.
- \`rg -t ts "pattern" .\` — restrict by language preset.
- \`rg -n "pattern" .\` — show line numbers (useful for follow-up edits).
- \`rg -l "pattern" .\` — list files only.
- \`rg -C 3 "pattern" .\` — 3 lines of context.
- **Always pass an explicit path** (e.g. \`.\` or \`src/\`) to \`rg\`. When no path is given and stdin is a pipe, ripgrep reads stdin instead of searching the filesystem, returning no results.`
    : `**For text search**, use \`grep\`. Examples:
- \`grep -rn "pattern" src/\` — recursive search with line numbers.
- \`grep -ri "pattern" src/\` — case-insensitive recursive search.
- \`grep -rl "pattern" src/\` — list matching files only.
- \`grep -C 3 "pattern" src/\` — show 3 lines of context.`;

  const fileSearch = hasFd
    ? `**For file search**, use \`fd\`. Examples:
- \`fd '\\.ts$'\` — regex over basenames.
- \`fd -e ts\` — by extension.
- \`fd -H -I\` — include hidden + gitignored (\`-uu\` style).
- \`fd 'pattern' path/\` — scoped to a directory.`
    : `**For file search**, use \`find\`. Examples:
- \`find src/ -type f -name '*.ts'\` — search a subtree by basename glob.
- **Always search from a specific path, not \`/\`.** Scanning the whole filesystem can exhaust resources on large trees.
- When using \`find -regex\` with alternation, put the longest alternative first: \`'.*\\.(tsx|ts)'\` works; \`'.*\\.(ts|tsx)'\` silently skips \`.tsx\`.`;

  const hygiene = `**General shell hygiene:**
- Quote paths that contain spaces.
- Prefer absolute paths or paths relative to a known root; avoid \`cd\`.
- When chaining commands, use \`&&\` for "stop on first failure", \`;\` only if you accept failures, never raw newlines.
- For destructive operations (deletes, force-pushes, schema migrations), pause and confirm before running.`;

  return `${header}\n\n${textSearch}\n\n${fileSearch}\n\n${hygiene}`;
}
