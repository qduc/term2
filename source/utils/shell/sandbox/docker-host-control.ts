import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';

export interface DockerHostControl {
  socketPath: string;
  configDir: string;
  cleanup(): void;
}

const DOCKER_BINARIES = new Set(['docker', 'docker-compose']);

// Programs that run another program, so the Docker invocation is one token later.
const COMMAND_WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'command',
  'exec',
  'builtin',
  'nohup',
  'nice',
  'ionice',
  'stdbuf',
  'time',
  'timeout',
  'xargs',
]);

// Shell punctuation that returns the scanner to command position: control
// operators, grouping, and redirection.
const OPERATOR_CHARS = ';|&()<>{}';
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_OPTION = /^-|^\d+(?:\.\d+)?[smhd]?$/;

interface ShellToken {
  value: string;
  isOperator: boolean;
}

/**
 * Splits a command into words and operators. Quoting matters: without it,
 * `git commit -m "fix(docker): update"` would look like a Docker invocation
 * after a subshell, and a false positive refuses the command outright.
 */
function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (word) tokens.push({ value: word, isOperator: false });
    word = '';
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      word += command[++index] ?? '';
      continue;
    }
    if (char === '\n') {
      // A newline separates commands exactly like `;`.
      endWord();
      tokens.push({ value: ';', isOperator: true });
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    if (OPERATOR_CHARS.includes(char)) {
      endWord();
      tokens.push({ value: char, isOperator: true });
      continue;
    }
    word += char;
  }

  endWord();
  return tokens;
}

/**
 * Recognizes direct Docker CLI invocations wherever the shell can put them:
 * after operators, inside subshells or brace groups, on a later line, behind a
 * wrapper such as `sudo`/`timeout`, or preceded by environment assignments.
 * Matching on command position rather than substring keeps `cat Dockerfile`
 * and `git commit -m "docker"` out. Docker reached indirectly (through a script
 * or package command) is out of reach of any command-string check.
 */
export function requestsDockerHostControl(command: string): boolean {
  let atCommandPosition = true;
  let afterWrapper = false;

  for (const { value, isOperator } of tokenizeShellCommand(command)) {
    if (isOperator) {
      atCommandPosition = true;
      afterWrapper = false;
      continue;
    }
    if (!atCommandPosition) continue;
    if (ENV_ASSIGNMENT.test(value)) continue;

    const name = value.split('/').pop() ?? '';
    if (DOCKER_BINARIES.has(name)) return true;
    if (COMMAND_WRAPPERS.has(name)) {
      afterWrapper = true;
      continue;
    }
    // A wrapper's own flags and durations still precede the real command.
    if (afterWrapper && WRAPPER_OPTION.test(value)) continue;

    atCommandPosition = false;
    afterWrapper = false;
  }

  return false;
}

// Docker cannot read its own config under the sandbox, so it loses the
// desktop-linux context and reports failure against the default socket. Both
// that form and a direct permission failure mean "the sandbox stood in the way".
const DOCKER_DAEMON_BLOCK_PATTERNS = [
  /permission denied while trying to connect to the docker (?:api|daemon)/i,
  /cannot connect to the docker daemon/i,
  /docker\.sock[^\n]*(?:permission denied|operation not permitted)/i,
  /(?:permission denied|operation not permitted)[^\n]*docker\.sock/i,
];

/**
 * Detects a sandboxed command that failed because it could not reach the Docker
 * daemon. This is the only signal available for Docker reached indirectly —
 * through a script, `make` target, or package command — where the command
 * string itself never mentions Docker.
 */
export function detectDockerDaemonBlock(stderr: string): boolean {
  return DOCKER_DAEMON_BLOCK_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Instruction shown to the agent when the sandbox blocked Docker, encouraging a
 * same-command retry so the user can approve host control for it.
 */
export const DOCKER_HOST_CONTROL_RETRY_INSTRUCTION =
  'Sandbox blocked this command from reaching the Docker daemon. Retry the same command; the user will be prompted to allow Docker host control for it.';

/**
 * Docker Desktop's Unix socket controls the host daemon, so this deliberately
 * recognizes only its canonical per-user macOS endpoint.
 */
export function createDockerHostControl(home = os.homedir()): DockerHostControl {
  if (process.platform !== 'darwin') {
    throw new Error('Docker host control is currently supported only on macOS.');
  }

  const socketPath = path.join(home, '.docker', 'run', 'docker.sock');
  let socketStat: fs.Stats;
  try {
    socketStat = fs.statSync(socketPath);
  } catch {
    throw new Error(`Docker Desktop socket is unavailable at ${socketPath}.`);
  }
  if (!socketStat.isSocket()) {
    throw new Error(`Docker Desktop endpoint is not a Unix socket: ${socketPath}.`);
  }

  const configDir = fs.mkdtempSync(path.join(SANDBOX_TEMP_DIR, 'docker-config-'));
  fs.chmodSync(configDir, 0o700);

  return {
    socketPath,
    configDir,
    cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }),
  };
}
