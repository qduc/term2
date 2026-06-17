import { describe, it, expect } from 'vitest';
import {
  canUseBell,
  getNotificationMethod,
  notify,
  sendNotification,
  supportsOsc777,
  supportsOsc9,
  buildNotificationSequence,
} from './notification-service.js';

function createStream(isTTY: boolean): NodeJS.WriteStream & { written: string } {
  let written = '';

  return {
    isTTY,
    get written() {
      return written;
    },
    write(data: string) {
      written += data;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { written: string };
}

it('supportsOsc777 recognizes supported terminals', () => {
  expect(supportsOsc777({ TERM_PROGRAM: 'ghostty' })).toBe(true);
  expect(supportsOsc777({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
  expect(supportsOsc777({ TERM: 'foot' })).toBe(true);
  expect(supportsOsc777({ TERM: 'foot-extra' })).toBe(true);
  expect(supportsOsc777({ TERM: 'xterm-ghostty-256color' })).toBe(true);
});

it('supportsOsc777 excludes kitty and unrelated terminals', () => {
  expect(supportsOsc777({ TERM_PROGRAM: 'kitty' })).toBe(false);
  expect(supportsOsc777({ TERM: 'xterm-kitty' })).toBe(false);
  expect(supportsOsc777({ TERM_PROGRAM: 'iTerm.app' })).toBe(false);
});

it('supportsOsc9 recognizes explicitly supported terminals', () => {
  expect(supportsOsc9({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
  expect(supportsOsc9({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
  expect(supportsOsc9({ TERM_PROGRAM: 'WarpTerminal' })).toBe(true);
  expect(supportsOsc9({ TERM: 'rio' })).toBe(true);
  expect(supportsOsc9({ TERM: 'rio-256color' })).toBe(true);
  expect(supportsOsc9({ TERM: 'wezterm' })).toBe(true);
});

it('supportsOsc9 excludes generic and unrelated terminals', () => {
  expect(supportsOsc9({ TERM: 'xterm-256color' })).toBe(false);
  expect(supportsOsc9({ TERM_PROGRAM: 'ghostty' })).toBe(false);
  expect(supportsOsc9({ TERM_PROGRAM: 'kitty' })).toBe(false);
  expect(supportsOsc9({})).toBe(false);
});

it('canUseBell requires a real TTY and non-CI environment', () => {
  expect(canUseBell({ TERM: 'xterm-256color' }, { isTTY: true } as NodeJS.WriteStream)).toBe(true);
  expect(canUseBell({ TERM: 'dumb' }, { isTTY: true } as NodeJS.WriteStream)).toBe(true);
  expect(canUseBell({ TERM: 'xterm-256color', CI: '1' }, { isTTY: true } as NodeJS.WriteStream)).toBe(false);
  expect(canUseBell({ TERM: 'xterm-256color' }, { isTTY: false } as NodeJS.WriteStream)).toBe(false);
  expect(canUseBell({}, { isTTY: true } as NodeJS.WriteStream)).toBe(true);
});

it('getNotificationMethod prefers OSC 777 over bell', () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  expect(getNotificationMethod({ TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' }, stream)).toBe('osc777');
});

it('getNotificationMethod falls back to OSC 9 for explicitly supported terminals', () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  expect(getNotificationMethod({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }, stream)).toBe('osc9');
  expect(getNotificationMethod({ TERM: 'rio' }, stream)).toBe('osc9');
});

it('getNotificationMethod returns undefined when no notification path is available', () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  expect(getNotificationMethod({ TERM: 'xterm-256color', CI: '1' }, stream)).toBeUndefined();
  expect(getNotificationMethod({ TERM: 'dumb' }, { isTTY: false } as NodeJS.WriteStream)).toBeUndefined();
});

it('getNotificationMethod falls back to bell for dumb terminals on a TTY', () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  expect(getNotificationMethod({ TERM: 'dumb' }, stream)).toBe('bell');
  expect(getNotificationMethod({ TERM: 'xterm-256color' }, stream)).toBe('bell');
});

it('notify writes OSC 777 for capable terminals and sanitizes payloads', () => {
  const stream = createStream(true);
  const result = notify('Ti;tle\x1b', 'Me\x07ss;age', {
    env: { TERM_PROGRAM: 'ghostty' },
    stream,
  });

  expect(result).toBe(true);
  expect(stream.written).toBe('\x1b]777;notify;Ti,tle;Mess,age\x07');
});

it('notify writes OSC 9 fallback for explicitly supported terminals', () => {
  const stream = createStream(true);
  const result = notify('Alert', 'Done', {
    env: { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
    stream,
  });

  expect(result).toBe(true);
  expect(stream.written).toBe('\x1b]9;Done\x07');
});

it('notify returns false when no notification method is available', () => {
  const stream = createStream(false);
  const result = notify('T', 'M', {
    env: { TERM: 'dumb' },
    stream,
  });

  expect(result).toBe(false);
  expect(stream.written).toBe('');
});

it('buildNotificationSequence mirrors the selected notification method', () => {
  expect(buildNotificationSequence('A', 'B', { TERM_PROGRAM: 'ghostty' }, { isTTY: true } as NodeJS.WriteStream)).toBe(
    '\x1b]777;notify;A;B\x07',
  );
  expect(
    buildNotificationSequence('A', 'B', { TERM_PROGRAM: 'iTerm.app' }, { isTTY: true } as NodeJS.WriteStream),
  ).toBe('\x1b]9;B\x07');
  expect(buildNotificationSequence('A', 'B', { TERM: 'xterm-256color' }, { isTTY: true } as NodeJS.WriteStream)).toBe(
    '\x07',
  );
  expect(buildNotificationSequence('A', 'B', {}, { isTTY: false } as NodeJS.WriteStream)).toBe('');
  expect(buildNotificationSequence('A', 'B', { TERM: 'dumb' }, { isTTY: true } as NodeJS.WriteStream)).toBe('\x07');
  expect(buildNotificationSequence('A', 'B', { TERM: 'dumb' }, { isTTY: false } as NodeJS.WriteStream)).toBe('');
});

it('sendNotification supports injected tty writers for compatibility', () => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'ghostty' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  expect(result).toBe(true);
  expect(written).toBe('\x1b]777;notify;Alert;Done\x07');
});

it('sendNotification wraps OSC sequences for tmux passthrough', () => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  expect(result).toBe(true);
  expect(written).toBe('\x1bPtmux;\x1b\x1b\x1b]777;notify;Alert;Done\x07\x1b\\');
});

it('sendNotification uses OSC 9 fallback through tty writer', () => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
    stream: { isTTY: false } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  expect(result).toBe(true);
  expect(written).toBe('\x1b]9;Done\x07');
});

it('sendNotification uses bell for unknown terminals on a TTY', () => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM: 'xterm-256color' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  expect(result).toBe(true);
  expect(written).toBe('\x07');
});
