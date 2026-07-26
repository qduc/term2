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
    ? `**For text search**, use \`rg\` (ripgrep). It respects \`.gitignore\` by default; \`--no-ignore\` or \`-uu\` when you need to search past it.

**Always pass an explicit path** (e.g. \`.\` or \`src/\`). With no path given and stdin attached to a pipe, ripgrep reads stdin instead of searching the filesystem and silently returns no results.`
    : `**For text search**, use \`grep\`, with \`-rn\` for a recursive search reporting line numbers.`;

  const fileSearch = hasFd
    ? `**For file search**, use \`fd\`. It also respects \`.gitignore\`; \`-H -I\` includes hidden and ignored files.`
    : `**For file search**, use \`find\`, scoped to a specific path rather than \`/\` — scanning the whole filesystem can exhaust resources on large trees.

With \`find -regex\` alternation, put the longest alternative first: \`'.*\\.(tsx|ts)'\` matches, while \`'.*\\.(ts|tsx)'\` silently skips \`.tsx\`.`;

  const hygiene = `**General shell hygiene:**
- Quote paths that contain spaces.
- Prefer absolute paths or paths relative to a known root; avoid \`cd\`.
- When chaining commands, use \`&&\` for "stop on first failure", \`;\` only if you accept failures, never raw newlines.
- For destructive operations (deletes, force-pushes, schema migrations), pause and confirm before running.`;

  return `${header}\n\n${textSearch}\n\n${fileSearch}\n\n${hygiene}`;
}
