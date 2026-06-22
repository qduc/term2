#!/usr/bin/env node
// @ts-check
/**
 * standalone-sandbox-library.ts
 *
 * Use the @anthropic-ai/sandbox-runtime library (the same library the project
 * uses) to run a command under the sandbox.
 *
 * This is the MOST FAITHFUL reproduction of the sandbox since it goes through
 * the exact same library code and project configuration helpers.
 *
 * REQUIREMENTS:
 *   - Run from the project root (needs node_modules and tsconfig.json).
 *   - Linux with bwrap AND socat installed.
 *   - An environment where Unix-domain sockets can be created (the library
 *     starts socat bridge processes that use UNIX-LISTEN sockets).  If you
 *     are already inside the project's sandbox, seccomp blocks these and
 *     initialization will fail — use the bash version instead.
 *
 * USAGE:
 *   node --import tsx/esm scripts/standalone-sandbox-library.ts [options] <command>
 *
 *   Alias (recommended):
 *     pnpm exec tsx scripts/standalone-sandbox-library.ts [options] <command>
 *
 * OPTIONS:
 *   -w, --cwd DIR                Workspace root (default: $PWD)
 *   -e, --allow-read-extra PATH  Extra allow-read path (repeatable, no colon separator)
 *   -p, --read-policy POLICY     'home-denylist' (default) or 'credential-denylist'
 *   -t, --timeout MS             Command timeout in milliseconds (default: 30000)
 *   -v, --verbose                Print config and wrapped command before running
 *   -d, --dry-run                Only print what would run, don't execute
 *   --show-env                   Show the filtered environment
 *   -h, --help                   Show this help
 *
 * EXAMPLES:
 *   pnpm exec tsx scripts/standalone-sandbox-library.ts pwd
 *   pnpm exec tsx scripts/standalone-sandbox-library.ts -v "cat ~/.ssh/id_rsa"
 *   pnpm exec tsx scripts/standalone-sandbox-library.ts -d "echo hello"
 *   pnpm exec tsx scripts/standalone-sandbox-library.ts \
 *     -e ~/.local/share/pnpm/store ls ~/.local/share/pnpm/store
 */

// ---------------------------------------------------------------------------
// Imports  — project modules + the anthropic sandbox library
// ---------------------------------------------------------------------------
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, type ExecSyncOptions } from 'node:child_process';

import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { createSandboxRuntimeConfig, type SandboxReadPolicy } from '../source/utils/shell/sandbox/sandbox-policy.js';
import { createSandboxEnvironment } from '../source/utils/shell/sandbox/sandbox-env.js';
import { SANDBOX_TEMP_DIR } from '../source/utils/shell/temp-dir.js';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eprint(msg: string): void {
  process.stderr.write(msg + '\n');
}

function showHelp(): void {
  const name = path.basename(process.argv[1] ?? 'standalone-sandbox-library.ts');
  console.log(`\
Usage: pnpm exec tsx ${name} [options] <command>

Run a command under the project's sandbox using @anthropic-ai/sandbox-runtime
directly — the most faithful reproduction available outside the app itself.

Options:
  -w, --cwd DIR                Workspace root (default: \$PWD)
  -e, --allow-read-extra PATH  Extra allow-read path (repeatable, use multiple -e flags)
  -p, --read-policy POLICY     'home-denylist' (default) or 'credential-denylist'
  -t, --timeout MS             Command timeout in ms (default: 30000)
  -v, --verbose                Print config and wrapped command
  -d, --dry-run                Print only, don't execute
  --show-env                   Show filtered environment
  -h, --help                   Show this help

Examples:
  pnpm exec tsx ${name} pwd
  pnpm exec tsx ${name} -v "cat ~/.ssh/id_rsa"
  pnpm exec tsx ${name} -e ~/.local/share/pnpm/store ls ~/.local/share/pnpm/store
  pnpm exec tsx ${name} -d "echo hello"
`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface Options {
  cwd: string;
  allowReadExtra: string[];
  readPolicy: SandboxReadPolicy;
  timeout: number;
  verbose: boolean;
  dryRun: boolean;
  showEnv: boolean;
  command: string;
}

function parseArgv(argv: string[]): Options {
  const opts: Options = {
    cwd: process.cwd(),
    allowReadExtra: [],
    readPolicy: 'home-denylist',
    timeout: 30_000,
    verbose: false,
    dryRun: false,
    showEnv: false,
    command: '',
  };

  const positional: string[] = [];
  let i = 2;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    switch (arg) {
      case '-w':
      case '--cwd':
        opts.cwd = path.resolve(argv[++i]);
        i++;
        break;
      case '-e':
      case '--allow-read-extra':
        opts.allowReadExtra.push(path.resolve(argv[++i]));
        i++;
        break;
      case '-p':
      case '--read-policy': {
        const val = argv[++i];
        if (val !== 'home-denylist' && val !== 'credential-denylist') {
          eprint(`Error: Invalid read policy "${val}". Use 'home-denylist' or 'credential-denylist'.`);
          process.exit(1);
        }
        opts.readPolicy = val;
        i++;
        break;
      }
      case '-t':
      case '--timeout':
        opts.timeout = parseInt(argv[++i], 10);
        if (isNaN(opts.timeout) || opts.timeout < 0) {
          eprint('Error: Invalid timeout value.');
          process.exit(1);
        }
        i++;
        break;
      case '-v':
      case '--verbose':
        opts.verbose = true;
        i++;
        break;
      case '-d':
      case '--dry-run':
        opts.dryRun = true;
        i++;
        break;
      case '--show-env':
        opts.showEnv = true;
        i++;
        break;
      case '-h':
      case '--help':
        showHelp();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          eprint(`Error: Unknown option: ${arg}`);
          process.exit(1);
        }
        positional.push(arg);
        i++;
    }
  }

  if (positional.length === 0) {
    eprint('Error: No command specified.');
    showHelp();
    process.exit(1);
  }

  opts.command = positional.join(' ');
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgv(process.argv);

  // 1. Check platform
  if (!SandboxManager.isSupportedPlatform()) {
    eprint('Error: Sandbox runtime does not support this platform.');
    process.exit(1);
  }

  // 2. Check bwrap dependency (socat only needed for network proxy, not
  //    for filesystem-only sandboxing, but the library checks for it.)
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    eprint('Error: Sandbox dependency check failed:');
    for (const err of deps.errors) eprint(`  ${err}`);
    eprint('');
    eprint('Make sure bwrap is installed. On Fedora: sudo dnf install bubblewrap');
    eprint('On Ubuntu/Debian: sudo apt install bubblewrap');
    process.exit(1);
  }
  if (deps.warnings.length > 0 && opts.verbose) {
    eprint('Dependency warnings:');
    for (const w of deps.warnings) eprint(`  ${w}`);
  }

  // 3. Build sandbox config using the PROJECT's own helper
  const sandboxConfig: SandboxRuntimeConfig = createSandboxRuntimeConfig({
    cwd: opts.cwd,
    readPolicy: opts.readPolicy,
    allowReadExtra: opts.allowReadExtra,
  });

  // 4. Print configuration (verbose or dry-run)
  if (opts.verbose || opts.dryRun) {
    console.log('=== Sandbox Configuration ===');
    console.log(`  Command:        ${opts.command}`);
    console.log(`  Workspace:      ${opts.cwd}`);
    console.log(`  Read policy:    ${opts.readPolicy}`);
    console.log(`  Timeout:        ${opts.timeout}ms`);
    console.log(`  Temp dir:       ${SANDBOX_TEMP_DIR}`);
    console.log(`  Deny-read:      ${sandboxConfig.filesystem.denyRead.join(', ')}`);
    if (sandboxConfig.filesystem.allowRead) {
      console.log(`  Allow-read:     ${sandboxConfig.filesystem.allowRead.join(', ')}`);
    }
    console.log(`  Allow-write:    ${sandboxConfig.filesystem.allowWrite.join(', ')}`);
    console.log(`  Deny-write:     ${sandboxConfig.filesystem.denyWrite.join(', ')}`);
    console.log(`  Allow-git-config: ${sandboxConfig.filesystem.allowGitConfig}`);
    if (sandboxConfig.credentials) {
      console.log(`  Credential files:  ${sandboxConfig.credentials.files?.length ?? 0}`);
      console.log(`  Credential envVars: ${sandboxConfig.credentials.envVars?.length ?? 0}`);
    }
    console.log();
  }

  // 5. Dry-run shortcut — show config but skip library initialization
  if (opts.dryRun) {
    console.log('=== Dry-run complete (command not executed) ===');
    return;
  }

  // 6. Set env var the sandbox library expects
  process.env.CLAUDE_CODE_TMPDIR = SANDBOX_TEMP_DIR;

  // 7. Initialize the sandbox library.
  //    This starts the HTTP/SOCKS proxy and, on Linux, socat bridge processes.
  //    If your environment blocks Unix-domain sockets (e.g. you're already in
  //    a sandbox with seccomp), this step will fail.
  if (opts.verbose) {
    eprint('Initializing sandbox library…');
  }
  try {
    await SandboxManager.initialize(sandboxConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    eprint('');
    eprint(`Error: Sandbox initialization failed: ${msg}`);
    eprint('');
    eprint('This commonly happens when:');
    eprint('  1. socat is not installed (install it: sudo dnf install socat)');
    eprint('  2. Unix-domain socket creation is blocked (seccomp filter active)');
    eprint('  3. /tmp is not writable');
    eprint('');
    eprint('Try the bash-based version instead which does not need the library:');
    eprint('  ./scripts/standalone-sandbox.sh [options] <command>');
    eprint('');
    eprint('Or run with --dry-run (-d) to see what config would be used.');
    process.exit(1);
  }

  // 8. Wrap the command
  if (opts.verbose) {
    eprint('Wrapping command with sandbox…');
  }
  const wrapped = await SandboxManager.wrapWithSandbox(opts.command);
  const warnings = SandboxManager.getLinuxGlobPatternWarnings?.() ?? [];
  if (warnings.length > 0 && opts.verbose) {
    eprint('Glob pattern warnings (Linux — patterns that could not be expanded):');
    for (const w of warnings) eprint(`  ${w}`);
  }

  if (opts.verbose) {
    console.log('=== Wrapped Command ===');
    console.log(wrapped);
    console.log();
  }

  // 9. Build filtered environment using the PROJECT's own helper
  const filteredEnv = createSandboxEnvironment();
  const childEnv: NodeJS.ProcessEnv = {
    ...filteredEnv,
    TMPDIR: SANDBOX_TEMP_DIR,
  };

  if (opts.showEnv) {
    console.log('=== Filtered Environment ===');
    for (const [key, value] of Object.entries(childEnv).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (value !== undefined) console.log(`  ${key}=${value}`);
    }
    console.log();
  }

  // 10. Execute
  if (opts.verbose) {
    eprint('=== Output ===');
  }

  const execOpts: ExecSyncOptions = {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: 1024 * 1024,
    env: childEnv as { [key: string]: string },
    stdio: 'inherit',
  };

  try {
    execSync(wrapped, execOpts);
  } catch (err: unknown) {
    const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number | null }).status : null;
    process.exit(status ?? 1);
  } finally {
    // 11. Cleanup
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {
      // best-effort
    }
  }
}

main().catch((err) => {
  eprint(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
