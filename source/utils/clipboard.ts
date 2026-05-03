import { spawnSync } from 'child_process';

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
  runCommand?: (command: string, args: string[], input: string) => ClipboardRunResult;
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

function defaultRunClipboardCommand(command: string, args: string[], input: string): ClipboardRunResult {
  const result = spawnSync(command, args, {
    input,
    stdio: ['pipe', 'ignore', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status === 0) {
    return { success: true };
  }

  if (result.error) {
    return {
      success: false,
      errorMessage: result.error.message,
    };
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return {
    success: false,
    errorMessage: stderr || `Command exited with status ${result.status ?? 'unknown'}`,
  };
}

export function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunClipboardCommand;
  const candidates = getClipboardCommandCandidates(platform, env);

  let lastError = '';

  for (const candidate of candidates) {
    const result = runCommand(candidate.command, candidate.args, text);
    if (result.success) {
      return;
    }

    lastError = result.errorMessage ?? '';
  }

  const supportedCommands = candidates.map((candidate) => candidate.command).join(', ');
  const detail = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Clipboard is unavailable on this system. Tried: ${supportedCommands}.${detail}`);
}
