import { extractWordText } from './utils.js';

/**
 * Check if a find command has dangerous execution flags (-exec, -execdir, -ok, -okdir, -delete)
 */
export function hasFindDangerousExecution(args: any[]): {
  dangerous: boolean;
  reason?: string;
} {
  for (let i = 0; i < args.length; i++) {
    const argText = extractWordText(args[i]);
    if (!argText) continue;

    // Check for -delete flag
    if (argText === '-delete') {
      return { dangerous: true, reason: 'find -delete (destructive)' };
    }

    // Check for execution flags
    const execFlags = ['-exec', '-execdir', '-ok', '-okdir'];
    if (!execFlags.includes(argText)) continue;

    // Found an exec flag - analyze the command it executes
    // Find the terminator (; or +)
    let terminatorIndex = -1;
    for (let j = i + 1; j < args.length; j++) {
      const term = extractWordText(args[j]);
      if (term === ';' || term === '+' || term === '\\;' || term === '\\+') {
        terminatorIndex = j;
        break;
      }
    }

    if (terminatorIndex === -1) continue;

    // Extract the command between exec flag and terminator
    const execArgs = args.slice(i + 1, terminatorIndex);

    // Check for redirects (which indicate shell operations). These are suspicious,
    // but not necessarily destructive without knowing the surrounding task.
    const hasRedirect = execArgs.some((a: any) => a?.type === 'Redirect');
    if (hasRedirect) continue;

    const execCommand = execArgs.map((a) => extractWordText(a)).filter(Boolean);

    if (execCommand.length === 0) continue;

    const cmdName = execCommand[0];
    if (!cmdName) {
      return {
        dangerous: true,
        reason: `find ${argText} with undefined command`,
      };
    }

    // Check if {} is the command itself (executing found files)
    if (cmdName === '{}') {
      return {
        dangerous: true,
        reason: `find ${argText} {} (executes found files directly)`,
      };
    }

    // Check for destructive commands
    const destructiveCmds = ['rm', 'shred', 'dd', 'mkfs', 'truncate'];
    if (destructiveCmds.includes(cmdName)) {
      return {
        dangerous: true,
        reason: `find ${argText} ${cmdName} (destructive)`,
      };
    }

    // Check for shell metacharacters in command. These make the command harder to
    // reason about, so they should remain YELLOW through hasFindSuspiciousFlags.
    const fullExecCmd = execCommand.join(' ');
    if (/[|&;$`<>]/.test(fullExecCmd)) continue;
  }

  return { dangerous: false };
}

/**
 * Check for suspicious find flags that warrant YELLOW classification
 */
export function hasFindSuspiciousFlags(args: any[]): {
  suspicious: boolean;
  reason?: string;
} {
  for (const arg of args) {
    const argText = extractWordText(arg);
    if (!argText) continue;

    // File output flags
    if (['-fprint', '-fprint0', '-fprintf', '-fls'].some((flag) => argText.startsWith(flag))) {
      return {
        suspicious: true,
        reason: `find ${argText} (file output)`,
      };
    }

    // Symlink following
    if (['-L', '-follow', '-H'].includes(argText)) {
      return {
        suspicious: true,
        reason: `find ${argText} (symlink following)`,
      };
    }

    // SUID/SGID permission searches
    if (argText === '-perm') {
      // Check the next argument for dangerous permission patterns
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        const permValue = extractWordText(args[nextIdx]);
        if (permValue) {
          // Numeric SUID/SGID patterns (e.g., -4000, /6000)
          const hasNumericSuid = /[-/]?[2467]000/.test(permValue);
          // Symbolic SUID/SGID patterns (e.g., -u+s, /g+s, +s)
          const hasSymbolicSuid = /[ug]?\+s/.test(permValue);

          if (hasNumericSuid || hasSymbolicSuid) {
            return {
              suspicious: true,
              reason: `find -perm ${permValue} (SUID/SGID search)`,
            };
          }
        }
      }
    }

    // Inode-based searches (can bypass path restrictions)
    if (argText === '-inum') {
      return {
        suspicious: true,
        reason: 'find -inum (inode-based access bypasses path checks)',
      };
    }

    // Read-only exec (still suspicious, requires approval)
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(argText)) {
      // If we reach here, hasFindDangerousExecution already passed (not RED)
      // but any -exec usage should still be YELLOW
      return {
        suspicious: true,
        reason: `find ${argText} (command execution)`,
      };
    }
  }

  return { suspicious: false };
}
