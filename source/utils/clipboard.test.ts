import test from 'ava';
import { copyToClipboard, copyViaOsc52, getClipboardCommandCandidates } from './clipboard.js';

// ── getClipboardCommandCandidates ───────────────────────────────────────────

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

// ── copyViaOsc52 ────────────────────────────────────────────────────────────

test('copyViaOsc52 writes bare OSC 52 sequence with base64-encoded text', async (t) => {
  let written = '';
  await copyViaOsc52('Hello', {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const expected = `\x1b]52;c;${Buffer.from('Hello').toString('base64')}\x07`;
  t.is(written, expected);
});

test('copyViaOsc52 wraps in tmux DCS passthrough when TMUX is set', async (t) => {
  let written = '';
  await copyViaOsc52('Hi', {
    env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const inner = `\x1b]52;c;${Buffer.from('Hi').toString('base64')}\x07`;
  const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
  t.is(written, `\x1bPtmux;\x1b${escaped}\x1b\\`);
});

test('copyViaOsc52 wraps in screen DCS passthrough when TERM starts with screen', async (t) => {
  let written = '';
  await copyViaOsc52('Hi', {
    env: { TERM: 'screen-256color' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  const inner = `\x1b]52;c;${Buffer.from('Hi').toString('base64')}\x07`;
  t.is(written, `\x1bP${inner}\x1b\\`);
});

test('copyViaOsc52 chunks screen DCS passthrough at 768 characters', async (t) => {
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
  t.true(inner.length > 768, 'precondition: inner sequence must exceed 768 chars');
  const chunk1 = inner.slice(0, 768);
  const chunk2 = inner.slice(768);
  t.is(written, `\x1bP${chunk1}\x1b\\` + `\x1bP${chunk2}\x1b\\`);
});

test('copyViaOsc52 throws when no TTY is available', async (t) => {
  const error = await t.throwsAsync(
    copyViaOsc52('hello', {
      env: {},
      getTtyWriter: () => null,
    }),
  );
  t.regex(error.message, /No TTY available/i);
});

test('copyViaOsc52 throws when text exceeds the size limit', async (t) => {
  const largeText = 'x'.repeat(71 * 1024);
  const error = await t.throwsAsync(
    copyViaOsc52(largeText, {
      env: {},
      getTtyWriter: () => (_data) => {},
    }),
  );
  t.regex(error.message, /too large/i);
});

// ── copyToClipboard ─────────────────────────────────────────────────────────

test('copyToClipboard uses the first successful command', async (t) => {
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

  t.deepEqual(calls, [{ command: 'pbcopy', args: [], input: 'hello' }]);
});

test('copyToClipboard falls back when a command is unavailable', async (t) => {
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

  t.deepEqual(calls, ['wl-copy', 'xclip']);
});

test('copyToClipboard throws when no clipboard command succeeds and no TTY is available', async (t) => {
  const error = await t.throwsAsync(
    copyToClipboard('hello', {
      platform: 'linux',
      env: {},
      runCommand: () => ({ success: false, errorMessage: 'not found' }),
      getTtyWriter: () => null,
    }),
  );

  t.regex(error.message, /Clipboard is unavailable/i);
  t.regex(error.message, /xclip, xsel, wl-copy/i);
});

test('copyToClipboard awaits asynchronous command results', async (t) => {
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

  t.deepEqual(calls, ['xclip', 'xsel']);
});

test('copyToClipboard uses OSC 52 when SSH_CONNECTION is set, not native', async (t) => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' },
    runCommand: () => {
      t.fail('native command should not be invoked in SSH session');
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.regex(written, /^\x1b\]52;c;/);
});

test('copyToClipboard uses OSC 52 when SSH_TTY is set', async (t) => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_TTY: '/dev/pts/0' },
    runCommand: () => {
      t.fail('should not call native');
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.truthy(written);
});

test('copyToClipboard uses OSC 52 when SSH_CLIENT is set', async (t) => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: { SSH_CLIENT: '10.0.0.1 12345 22' },
    runCommand: () => {
      t.fail('should not call native');
      return { success: false };
    },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.truthy(written);
});

test('copyToClipboard falls back to OSC 52 when all native commands fail locally', async (t) => {
  let written = '';
  await copyToClipboard('hello', {
    platform: 'linux',
    env: {},
    runCommand: () => ({ success: false, errorMessage: 'not found' }),
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.regex(written, /^\x1b\]52;c;/);
});

test('copyToClipboard rethrows native error when native fails and no TTY is available locally', async (t) => {
  const error = await t.throwsAsync(
    copyToClipboard('hello', {
      platform: 'linux',
      env: {},
      runCommand: () => ({ success: false, errorMessage: 'not found' }),
      getTtyWriter: () => null,
    }),
  );
  t.regex(error.message, /Clipboard is unavailable/i);
});

test('copyToClipboard throws no-TTY error when in SSH session and no TTY is available', async (t) => {
  const error = await t.throwsAsync(
    copyToClipboard('hello', {
      platform: 'linux',
      env: { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' },
      runCommand: () => {
        t.fail('should not call native');
        return { success: false };
      },
      getTtyWriter: () => null,
    }),
  );
  t.regex(error.message, /No TTY available/i);
});
