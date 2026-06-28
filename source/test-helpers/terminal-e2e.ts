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

const DEFAULT_TIMEOUT_MS = 30_000;

const PYTHON_PTY_BRIDGE = ['import pty', 'import sys', 'sys.exit(pty.spawn(sys.argv[1:]))'].join('; ');

export function spawnTerminal(command: string, args: string[], options: SpawnTerminalOptions = {}): TerminalSession {
  const terminal = spawn('python3', ['-u', '-c', PYTHON_PTY_BRIDGE, command, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
          reject(new Error(`Terminal exited before output appeared: ${needle}`));
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for terminal output: ${needle}`));
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
