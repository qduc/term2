import { spawn } from 'child_process';

export interface ClipboardCommandCandidate {
  command: string;
  args: string[];
}

export interface ClipboardRunResult {
  success: boolean;
  errorMessage?: string;
}

export interface CopyToClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[], input: string) => ClipboardRunResult | Promise<ClipboardRunResult>;
}

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

export async function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunClipboardCommand;
  const candidates = getClipboardCommandCandidates(platform, env);

  let lastError = '';

  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, text);
    if (result.success) {
      return;
    }

    lastError = result.errorMessage ?? '';
  }

  const supportedCommands = candidates.map((candidate) => candidate.command).join(', ');
  const detail = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Clipboard is unavailable on this system. Tried: ${supportedCommands}.${detail}`);
}
