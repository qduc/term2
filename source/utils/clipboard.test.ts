import { it, expect } from 'vitest';
import { copyToClipboard, copyViaOsc52, getClipboardCommandCandidates } from './clipboard.js';

// ── getClipboardCommandCandidates ───────────────────────────────────────────

it('getClipboardCommandCandidates returns macOS command', () => {
  expect(getClipboardCommandCandidates('darwin', {})).toEqual([{ command: 'pbcopy', args: [] }]);
});

it('getClipboardCommandCandidates returns Windows command', () => {
  expect(getClipboardCommandCandidates('win32', {})).toEqual([{ command: 'clip', args: [] }]);
});

it('getClipboardCommandCandidates prefers wl-copy on Wayland and falls back to X11 tools', () => {
  expect(getClipboardCommandCandidates('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual([
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ]);
});

it('getClipboardCommandCandidates prefers X11 tools when Wayland is not present', () => {
  expect(getClipboardCommandCandidates('linux', {})).toEqual([
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
    { command: 'wl-copy', args: [] },
  ]);
});

// ── copyViaOsc52 ────────────────────────────────────────────────────────────

it('copyViaOsc52 writes bare OSC 52 sequence with base64-encoded text', async () => {
  let written = '';
  await copyViaOsc52('Hello', {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const expected = `\x1b]52;c;${Buffer.from('Hello').toString('base64')}\x07`;
  expect(written).toBe(expected);
});

it('copyViaOsc52 wraps in tmux DCS passthrough when TMUX is set', async () => {
  let written = '';
  await copyViaOsc52('Hi', {
    env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const inner = `\x1b]52;c;${Buffer.from('Hi').toString('base64')}\x07`;
  const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
  expect(written).toBe(`\x1bPtmux;\x1b${escaped}\x1b\\`);
});

it('copyViaOsc52 wraps in screen DCS passthrough when TERM starts with screen', async () => {
  let written = '';
  await copyViaOsc52('Hi', {
    env: { TERM: 'screen-256color' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const inner = `\x1b]52;c;${Buffer.from('Hi').toString('base64')}\x07`;
  expect(written).toBe(`\x1bP${inner}\x1b\\`);
});

it('copyViaOsc52 chunks screen DCS passthrough at 768 characters', async () => {
  // 600 raw bytes → ~800 base64 chars → inner length > 768
  const longText = 'x'.repeat(600);
  let written = '';
  await copyViaOsc52(longText, {
    env: { TERM: 'screen' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const inner = `\x1b]52;c;${Buffer.from(longText).toString('base64')}\x07`;
  expect(inner.length > 768).toBe(true);
  const chunk1 = inner.slice(0, 768);
  const chunk2 = inner.slice(768);
  expect(written).toBe(`\x1bP${chunk1}\x1b\\` + `\x1bP${chunk2}\x1b\\`);
});

it('copyViaOsc52 throws when no TTY is available', async () => {
  await expect(
    copyViaOsc52('hello', {
      env: {},
      getTtyWriter: () => null,
    }),
  ).rejects.toThrow(/No TTY available/i);
});

it('copyViaOsc52 throws when text exceeds the size limit', async () => {
  const largeText = 'x'.repeat(71 * 1024);

  await expect(
    copyViaOsc52(largeText, {
      env: {},
      getTtyWriter: () => (_data) => {},
    }),
  ).rejects.toThrow(/too large/i);
});

// ── copyToClipboard ─────────────────────────────────────────────────────────

it('copyToClipboard uses the first successful command', async () => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];

  await copyToClipboard('hello', {
    platform: 'darwin',
    env: {},
    runCommand: (command, args, input) => {
      calls.push({ command, args, input });
      return { success: true };
    },
    getTtyWriter: () => null,
  });

  expect(calls).toEqual([{ command: 'pbcopy', args: [], input: 'hello' }]);
});

it('copyToClipboard falls back when a command is unavailable', async () => {
  const calls: string[] = [];

  await copyToClipboard('hello', {
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    runCommand: (command) => {
      calls.push(command);
      if (command === 'wl-copy') {
        return { success: false, errorMessage: 'spawn wl-copy ENOENT' };
      }

      return { success: true };
    },
    getTtyWriter: () => null,
  });

  expect(calls).toEqual(['wl-copy', 'xclip']);
});

it('copyToClipboard throws when no clipboard command succeeds and no TTY is available', async () => {
  await expect(
    copyToClipboard('hello', {
      platform: 'linux',
      env: {},
      runCommand: () => ({ success: false, errorMessage: 'not found' }),
      getTtyWriter: () => null,
    }),
  ).rejects.toThrow(/Clipboard is unavailable/i);
});

it('copyToClipboard awaits asynchronous command results', async () => {
  const calls: string[] = [];

  await copyToClipboard('hello', {
    platform: 'linux',
    env: {},
    runCommand: async (command) => {
      calls.push(command);
      if (command === 'xclip') {
        return { success: false, errorMessage: 'temporarily unavailable' };
      }

      return new Promise<{ success: true }>((resolve) => {
        setTimeout(() => {
          resolve({ success: true });
        }, 10);
      });
    },
    getTtyWriter: () => null,
  });

  expect(calls).toEqual(['xclip', 'xsel']);
});

it('copyToClipboard uses OSC 52 when SSH_CONNECTION is set, not native', async () => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' },
    runCommand: () => {
      expect(true).toBe(false);
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  expect(written).toMatch(/^\x1b\]52;c;/);
});

it('copyToClipboard uses OSC 52 when SSH_TTY is set', async () => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_TTY: '/dev/pts/0' },
    runCommand: () => {
      expect(true).toBe(false);
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  expect(written).toBeTruthy();
});

it('copyToClipboard uses OSC 52 when SSH_CLIENT is set', async () => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_CLIENT: '10.0.0.1 12345 22' },
    runCommand: () => {
      expect(true).toBe(false);
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  expect(written).toBeTruthy();
});

it('copyToClipboard falls back to OSC 52 when all native commands fail locally', async () => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: {},
    runCommand: () => ({ success: false, errorMessage: 'not found' }),
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  expect(written).toMatch(/^\x1b\]52;c;/);
});

it('copyToClipboard rethrows native error when native fails and no TTY is available locally', async () => {
  await expect(
    copyToClipboard('hello', {
      platform: 'linux',
      env: {},
      runCommand: () => ({ success: false, errorMessage: 'not found' }),
      getTtyWriter: () => null,
    }),
  ).rejects.toThrow(/Clipboard is unavailable/i);
});

it('copyToClipboard throws no-TTY error when in SSH session and no TTY is available', async () => {
  await expect(
    copyToClipboard('hello', {
      platform: 'linux',
      env: { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' },
      runCommand: () => {
        expect(true).toBe(false);
        return { success: false };
      },
      getTtyWriter: () => null,
    }),
  ).rejects.toThrow(/No TTY available/i);
});
