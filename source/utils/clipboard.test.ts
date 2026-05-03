import test from 'ava';
import { copyToClipboard, getClipboardCommandCandidates } from './clipboard.js';

test('getClipboardCommandCandidates returns macOS command', (t) => {
  t.deepEqual(getClipboardCommandCandidates('darwin', {}), [{ command: 'pbcopy', args: [] }]);
});

test('getClipboardCommandCandidates returns Windows command', (t) => {
  t.deepEqual(getClipboardCommandCandidates('win32', {}), [{ command: 'clip', args: [] }]);
});

test('getClipboardCommandCandidates prefers wl-copy on Wayland and falls back to X11 tools', (t) => {
  t.deepEqual(getClipboardCommandCandidates('linux', { WAYLAND_DISPLAY: 'wayland-0' }), [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ]);
});

test('getClipboardCommandCandidates prefers X11 tools when Wayland is not present', (t) => {
  t.deepEqual(getClipboardCommandCandidates('linux', {}), [
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
    { command: 'wl-copy', args: [] },
  ]);
});

test('copyToClipboard uses the first successful command', (t) => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];

  copyToClipboard('hello', {
    platform: 'darwin',
    env: {},
    runCommand: (command, args, input) => {
      calls.push({ command, args, input });
      return { success: true };
    },
  });

  t.deepEqual(calls, [{ command: 'pbcopy', args: [], input: 'hello' }]);
});

test('copyToClipboard falls back when a command is unavailable', (t) => {
  const calls: string[] = [];

  copyToClipboard('hello', {
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    runCommand: (command) => {
      calls.push(command);
      if (command === 'wl-copy') {
        return { success: false, errorMessage: 'spawn wl-copy ENOENT' };
      }

      return { success: true };
    },
  });

  t.deepEqual(calls, ['wl-copy', 'xclip']);
});

test('copyToClipboard throws when no clipboard command succeeds', (t) => {
  const error = t.throws(() =>
    copyToClipboard('hello', {
      platform: 'linux',
      env: {},
      runCommand: () => ({ success: false, errorMessage: 'not found' }),
    }),
  );

  t.regex(error.message, /Clipboard is unavailable/i);
  t.regex(error.message, /xclip, xsel, wl-copy/i);
});
