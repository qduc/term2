import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';

/** Resolve an explicitly selected CLI before fixtures change cwd or filter env. */
export function testCliPath(fallback: string): string {
  return process.env.TERM2_TEST_CLI ? path.resolve(process.env.TERM2_TEST_CLI) : fallback;
}

export type TerminalExit = {
  exitCode: number;
  signal?: string;
};

export type SpawnTerminalOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
};

export type TerminalSession = {
  readonly bridgePid: number;
  getOutput: () => string;
  getVisibleOutput: () => string;
  write: (data: string) => void;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<void>;
  waitForExit: (timeoutMs?: number) => Promise<TerminalExit>;
  kill: (signal?: number | NodeJS.Signals) => void;
  dispose: () => void;
};

// TERM2_TEST_OWNER marks the worker's children for workspace-process-sweep.ts.
const CHILD_ENV_KEYS = [
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'CI',
  'NODE_ENV',
  'TERM2_TEST_OWNER',
  'TERM2_EXIT_CONFIRM_WINDOW_MS',
];

/** Build a child environment without leaking ambient credentials or service URLs. */
export function createTestChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TERM = 'xterm-256color';
  env.FORCE_COLOR = '1';
  if (process.env.TERM2_TEST_NODE_COMPILE_CACHE) {
    env.NODE_COMPILE_CACHE = process.env.TERM2_TEST_NODE_COMPILE_CACHE;
  }
  return { ...env, ...overrides };
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Timeout errors are the only window into a headless CI terminal; include the
// last chunk of what the child actually rendered so a blind wait failure can
// be diagnosed from the log alone.
function tailOf(text: string, max = 800): string {
  const stripped = stripVTControlCharacters(text).trimEnd();
  return stripped.length > max ? `…${stripped.slice(-max)}` : stripped;
}

/**
 * Python for a PTY bridge: answer Primary Device Attributes like a real terminal.
 *
 * The TUI asks for the background colour (OSC 11) followed by DA1 before Ink starts, and treats the
 * DA1 reply as "all replies are in". Every terminal answers DA1; a bridge that stays silent sends
 * each launch down the detection timeout backstop instead (150ms per start, and per restart). This
 * answers DA1 only, as a terminal without OSC 11 support would, so the detected background stays
 * unknown exactly as before. `answer_da1(fd, chunk)` scans child output, including a query split
 * across reads, and writes one reply per query to the PTY master.
 */
export const PYTHON_DA1_RESPONDER = `
DA1_QUERIES = (b'\\x1b[c', b'\\x1b[0c')
DA1_REPLY = b'\\x1b[?62;22c'
da1_carry = b''
def answer_da1(fd, chunk):
    global da1_carry
    scan = da1_carry + chunk
    for query in DA1_QUERIES:
        at = scan.find(query)
        while at >= 0:
            if at + len(query) > len(da1_carry):
                os.write(fd, DA1_REPLY)
            at = scan.find(query, at + 1)
    da1_carry = scan[-3:]
`;

const PYTHON_PTY_BRIDGE = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios
${PYTHON_DA1_RESPONDER}
rows, cols = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
stdin_open = True
while True:
    readers = [master] + ([sys.stdin.fileno()] if stdin_open else [])
    readable, _, _ = select.select(readers, [], [])
    if master in readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        os.write(sys.stdout.fileno(), chunk)
        answer_da1(master, chunk)
    if stdin_open and sys.stdin.fileno() in readable:
        chunk = os.read(sys.stdin.fileno(), 4096)
        if chunk:
            os.write(master, chunk)
        else:
            stdin_open = False
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export function spawnTerminal(command: string, args: string[], options: SpawnTerminalOptions = {}): TerminalSession {
  const terminal = spawn(
    'python3',
    ['-u', '-c', PYTHON_PTY_BRIDGE, String(options.rows ?? 24), String(options.cols ?? 80), command, ...args],
    {
      cwd: options.cwd ?? process.cwd(),
      env: createTestChildEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let output = '';
  let exitState: TerminalExit | null = null;
  let exitResolve: ((exit: TerminalExit) => void) | null = null;
  let exitReject: ((error: Error) => void) | null = null;
  const exitPromise = new Promise<TerminalExit>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });

  // Preserve UTF-8 characters split across arbitrary PTY pipe chunks.
  terminal.stdout?.setEncoding('utf8');
  terminal.stdout?.on('data', (chunk: Buffer | string) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });

  terminal.on('error', (error) => {
    exitReject?.(error instanceof Error ? error : new Error(String(error)));
    exitReject = null;
    exitResolve = null;
  });

  terminal.on('close', (code, signal) => {
    const event: TerminalExit = { exitCode: code ?? 0, signal: signal ?? undefined };
    exitState = event;
    exitResolve?.(event);
    exitResolve = null;
    exitReject = null;
  });

  const waitForOutput = async (needle: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> => {
    if (getVisibleOutput().includes(needle)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (getVisibleOutput().includes(needle)) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (exitState) {
          clearInterval(timer);
          reject(
            new Error(
              `Terminal exited before output appeared: ${needle}\n` +
                `exit code=${exitState.exitCode} signal=${exitState.signal ?? 'none'}\n` +
                `visible output (tail):\n${tailOf(getVisibleOutput())}`,
            ),
          );
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(
            new Error(
              `Timed out waiting for terminal output: ${needle}\n` +
                `visible output (tail):\n${tailOf(getVisibleOutput())}`,
            ),
          );
        }
      }, 25);

      void exitPromise.then(() => {
        clearInterval(timer);
        reject(new Error(`Terminal exited before output appeared: ${needle}`));
      });
    });
  };

  const waitForExit = async (timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TerminalExit> => {
    if (exitState) {
      return exitState;
    }

    return await new Promise<TerminalExit>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for terminal process to exit'));
      }, timeoutMs);

      void exitPromise.then((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  };

  // Waits poll this every 25ms over the whole session's output. Output only grows, so strip it
  // again only after new bytes arrive instead of on every poll.
  let visible = '';
  let visibleLength = 0;
  const getVisibleOutput = () => {
    if (visibleLength !== output.length) {
      visible = stripVTControlCharacters(output);
      visibleLength = output.length;
    }
    return visible;
  };

  return {
    bridgePid: terminal.pid!,
    getOutput: () => output,
    getVisibleOutput,
    write: (data: string) => {
      terminal.stdin?.write(data);
    },
    waitForOutput,
    waitForExit,
    kill: (signal: number | NodeJS.Signals = 'SIGTERM') => {
      terminal.kill(signal);
    },
    dispose: () => {
      if (exitState) return;
      killPtyChildren(terminal.pid);
      terminal.kill();
    },
  };
}

/**
 * SIGKILL the process group of each child of a PTY bridge: the CLI leads its own session there.
 *
 * Killing only the bridge closes the PTY, which merely hangs the CLI up. Its shutdown then kept
 * writing under the test's HOME while `afterEach` removed that directory, failing teardown with
 * ENOTEMPTY (the "teardown race" in the testing skill). Linux-only, like the workspace sweep:
 * elsewhere the bridge kill alone remains.
 */
function killPtyChildren(bridgePid: number | undefined): void {
  if (process.platform !== 'linux' || !bridgePid) return;
  let children: string[];
  try {
    children = fs.readFileSync(`/proc/${bridgePid}/task/${bridgePid}/children`, 'utf8').split(/\s+/).filter(Boolean);
  } catch {
    return; // the bridge already exited
  }
  for (const child of children.map(Number)) {
    try {
      process.kill(-child, 'SIGKILL');
    } catch {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        // exited meanwhile
      }
    }
  }
}

/** Press the Enter that closes a slash menu showing no match for the typed `text`, and wait until it closed. */
export async function dismissNoMatchSlashMenu(session: TerminalSession, text: string): Promise<void> {
  const menu = () => session.getVisibleOutput().lastIndexOf('No matching commands');
  const composer = () => session.getVisibleOutput().lastIndexOf(`❯ ${text}`);
  const until = async (done: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`The slash menu did not ${what} for ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await until(() => menu() > composer(), 'open');
  session.write('\r');
  await until(() => composer() > menu(), 'close');
}
