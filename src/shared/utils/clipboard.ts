import { spawn } from 'child_process';
import { getTtyWriter as defaultGetTtyWriter, wrapForMultiplexer, type TtyWriter } from './output/tty-osc.js';

export interface ClipboardCommandCandidate {
  command: string;
  args: string[];
}

export interface ClipboardRunResult {
  success: boolean;
  errorMessage?: string;
}

// Re-export TtyWriter so callers that imported it from clipboard.ts continue to work
export type { TtyWriter } from './output/tty-osc.js';

export interface Osc52Options {
  env?: NodeJS.ProcessEnv;
  getTtyWriter?: () => TtyWriter | null;
}

export interface CopyToClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], input: string) => ClipboardRunResult | Promise<ClipboardRunResult>;
  getTtyWriter?: () => TtyWriter | null;
}

const OSC52_MAX_BYTES = 70 * 1024;

export function getClipboardCommandCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClipboardCommandCandidate[] {
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }

  if (platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }

  const waylandFirst = [{ command: 'wl-copy', args: [] }];
  const x11Fallbacks = [
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];

  return env.WAYLAND_DISPLAY ? [...waylandFirst, ...x11Fallbacks] : [...x11Fallbacks, ...waylandFirst];
}

function defaultRunClipboardCommand(command: string, args: string[], input: string): Promise<ClipboardRunResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let successTimer: NodeJS.Timeout | undefined;

    const finish = (result: ClipboardRunResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (successTimer) {
        clearTimeout(successTimer);
      }

      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    child.on('error', (error) => {
      finish({
        success: false,
        errorMessage: error.message,
      });
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ success: true });
        return;
      }

      const errorMessage = stderr.trim() || `Command exited with status ${code ?? 'unknown'}`;
      finish({
        success: false,
        errorMessage,
      });
    });

    child.stdin.on('error', () => {
      // Ignore pipe shutdown races once the child has finished reading input.
    });

    child.stdin.end(input, 'utf8', () => {
      // Some Linux clipboard tools stay alive to own the clipboard selection.
      // Treat that as success after a short grace period instead of blocking the UI.
      successTimer = setTimeout(() => {
        child.stderr?.destroy();
        child.unref();
        finish({ success: true });
      }, 100);
      successTimer.unref?.();
    });
  });
}

function buildOsc52Sequence(text: string, env: NodeJS.ProcessEnv): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const inner = `\x1b]52;c;${encoded}\x07`;
  return wrapForMultiplexer(inner, env);
}

export async function copyViaOsc52(text: string, options: Osc52Options = {}): Promise<void> {
  const env = options.env ?? process.env;
  const getTtyWriter = options.getTtyWriter ?? defaultGetTtyWriter;

  if (Buffer.byteLength(text, 'utf8') > OSC52_MAX_BYTES) {
    throw new Error(
      `Response too large to copy over SSH (${Buffer.byteLength(
        text,
        'utf8',
      )} bytes; limit is ${OSC52_MAX_BYTES} bytes)`,
    );
  }

  const writer = getTtyWriter();
  if (!writer) {
    throw new Error('No TTY available for OSC 52 clipboard write');
  }

  writer(buildOsc52Sequence(text, env));
}

function isSSHSession(env: NodeJS.ProcessEnv): boolean {
  return !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

async function runNativeCopy(
  text: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runCommand: (command: string, args: string[], input: string) => ClipboardRunResult | Promise<ClipboardRunResult>,
): Promise<void> {
  const candidates = getClipboardCommandCandidates(platform, env);
  let lastError = '';

  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, text);
    if (result.success) {
      return;
    }

    lastError = result.errorMessage ?? '';
  }

  const supportedCommands = candidates.map((c) => c.command).join(', ');
  const detail = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Clipboard is unavailable on this system. Tried: ${supportedCommands}.${detail}`);
}

export async function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunClipboardCommand;
  const getTtyWriter = options.getTtyWriter ?? defaultGetTtyWriter;

  if (isSSHSession(env)) {
    // Native clipboard on the remote host would be the wrong machine's clipboard.
    await copyViaOsc52(text, { env, getTtyWriter });
    return;
  }

  // Local: try native first.
  try {
    await runNativeCopy(text, platform, env, runCommand);
    return;
  } catch (nativeErr) {
    // Native failed — try OSC 52 if the content fits and a TTY is available.
    if (Buffer.byteLength(text, 'utf8') > OSC52_MAX_BYTES) {
      throw nativeErr;
    }

    const ttyWriter = getTtyWriter();
    if (!ttyWriter) {
      throw nativeErr;
    }

    ttyWriter(buildOsc52Sequence(text, env));
  }
}
