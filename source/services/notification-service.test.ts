import test from 'ava';
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

test('supportsOsc777 recognizes supported terminals', (t) => {
  t.true(supportsOsc777({ TERM_PROGRAM: 'ghostty' }));
  t.true(supportsOsc777({ TERM_PROGRAM: 'WezTerm' }));
  t.true(supportsOsc777({ TERM: 'foot' }));
  t.true(supportsOsc777({ TERM: 'foot-extra' }));
  t.true(supportsOsc777({ TERM: 'xterm-ghostty-256color' }));
});

test('supportsOsc777 excludes kitty and unrelated terminals', (t) => {
  t.false(supportsOsc777({ TERM_PROGRAM: 'kitty' }));
  t.false(supportsOsc777({ TERM: 'xterm-kitty' }));
  t.false(supportsOsc777({ TERM_PROGRAM: 'iTerm.app' }));
});

test('supportsOsc9 recognizes explicitly supported terminals', (t) => {
  t.true(supportsOsc9({ TERM_PROGRAM: 'iTerm.app' }));
  t.true(supportsOsc9({ TERM_PROGRAM: 'WezTerm' }));
  t.true(supportsOsc9({ TERM_PROGRAM: 'WarpTerminal' }));
  t.true(supportsOsc9({ TERM: 'rio' }));
  t.true(supportsOsc9({ TERM: 'rio-256color' }));
  t.true(supportsOsc9({ TERM: 'wezterm' }));
});

test('supportsOsc9 excludes generic and unrelated terminals', (t) => {
  t.false(supportsOsc9({ TERM: 'xterm-256color' }));
  t.false(supportsOsc9({ TERM_PROGRAM: 'ghostty' }));
  t.false(supportsOsc9({ TERM_PROGRAM: 'kitty' }));
  t.false(supportsOsc9({}));
});

test('canUseBell requires a real TTY and non-CI environment', (t) => {
  t.true(canUseBell({ TERM: 'xterm-256color' }, { isTTY: true } as NodeJS.WriteStream));
  t.true(canUseBell({ TERM: 'dumb' }, { isTTY: true } as NodeJS.WriteStream));
  t.false(canUseBell({ TERM: 'xterm-256color', CI: '1' }, { isTTY: true } as NodeJS.WriteStream));
  t.false(canUseBell({ TERM: 'xterm-256color' }, { isTTY: false } as NodeJS.WriteStream));
  t.true(canUseBell({}, { isTTY: true } as NodeJS.WriteStream));
});

test('getNotificationMethod prefers OSC 777 over bell', (t) => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  t.is(getNotificationMethod({ TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' }, stream), 'osc777');
});

test('getNotificationMethod falls back to OSC 9 for explicitly supported terminals', (t) => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  t.is(getNotificationMethod({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }, stream), 'osc9');
  t.is(getNotificationMethod({ TERM: 'rio' }, stream), 'osc9');
});

test('getNotificationMethod returns undefined when no notification path is available', (t) => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  t.is(getNotificationMethod({ TERM: 'xterm-256color', CI: '1' }, stream), undefined);
  t.is(getNotificationMethod({ TERM: 'dumb' }, { isTTY: false } as NodeJS.WriteStream), undefined);
});

test('getNotificationMethod falls back to bell for dumb terminals on a TTY', (t) => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  t.is(getNotificationMethod({ TERM: 'dumb' }, stream), 'bell');
  t.is(getNotificationMethod({ TERM: 'xterm-256color' }, stream), 'bell');
});

test('notify writes OSC 777 for capable terminals and sanitizes payloads', (t) => {
  const stream = createStream(true);
  const result = notify('Ti;tle\x1b', 'Me\x07ss;age', {
    env: { TERM_PROGRAM: 'ghostty' },
    stream,
  });

  t.true(result);
  t.is(stream.written, '\x1b]777;notify;Ti,tle;Mess,age\x07');
});

test('notify writes OSC 9 fallback for explicitly supported terminals', (t) => {
  const stream = createStream(true);
  const result = notify('Alert', 'Done', {
    env: { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
    stream,
  });

  t.true(result);
  t.is(stream.written, '\x1b]9;Done\x07');
});

test('notify returns false when no notification method is available', (t) => {
  const stream = createStream(false);
  const result = notify('T', 'M', {
    env: { TERM: 'dumb' },
    stream,
  });

  t.false(result);
  t.is(stream.written, '');
});

test('buildNotificationSequence mirrors the selected notification method', (t) => {
  t.is(
    buildNotificationSequence('A', 'B', { TERM_PROGRAM: 'ghostty' }, { isTTY: true } as NodeJS.WriteStream),
    '\x1b]777;notify;A;B\x07',
  );
  t.is(
    buildNotificationSequence('A', 'B', { TERM_PROGRAM: 'iTerm.app' }, { isTTY: true } as NodeJS.WriteStream),
    '\x1b]9;B\x07',
  );
  t.is(buildNotificationSequence('A', 'B', { TERM: 'xterm-256color' }, { isTTY: true } as NodeJS.WriteStream), '\x07');
  t.is(buildNotificationSequence('A', 'B', {}, { isTTY: false } as NodeJS.WriteStream), '');
  t.is(buildNotificationSequence('A', 'B', { TERM: 'dumb' }, { isTTY: true } as NodeJS.WriteStream), '\x07');
  t.is(buildNotificationSequence('A', 'B', { TERM: 'dumb' }, { isTTY: false } as NodeJS.WriteStream), '');
});

test('sendNotification supports injected tty writers for compatibility', (t) => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'ghostty' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  t.true(result);
  t.is(written, '\x1b]777;notify;Alert;Done\x07');
});

test('sendNotification wraps OSC sequences for tmux passthrough', (t) => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  t.true(result);
  t.is(written, '\x1bPtmux;\x1b\x1b\x1b]777;notify;Alert;Done\x07\x1b\\');
});

test('sendNotification uses OSC 9 fallback through tty writer', (t) => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
    stream: { isTTY: false } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  t.true(result);
  t.is(written, '\x1b]9;Done\x07');
});

test('sendNotification uses bell for unknown terminals on a TTY', (t) => {
  let written = '';

  const result = sendNotification('Alert', 'Done', {
    env: { TERM: 'xterm-256color' },
    stream: { isTTY: true } as NodeJS.WriteStream,
    getTtyWriter: () => (data) => {
      written = data;
    },
  });

  t.true(result);
  t.is(written, '\x07');
});
