import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

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
  getOutput: () => string;
  getVisibleOutput: () => string;
  write: (data: string) => void;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<void>;
  waitForExit: (timeoutMs?: number) => Promise<TerminalExit>;
  kill: (signal?: number | NodeJS.Signals) => void;
  dispose: () => void;
};

const CHILD_ENV_KEYS = ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI', 'NODE_ENV'];

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

const PYTHON_PTY_BRIDGE = `
import fcntl
import os
import pty
import select
import struct
import sys
import termios

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

  const getVisibleOutput = () => stripVTControlCharacters(output);

  return {
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
      terminal.kill();
    },
  };
}
