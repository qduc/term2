import test from 'ava';
import { buildNotificationSequence, sendNotification } from './notification-service.js';

// ── OSC format selection ────────────────────────────────────────────────────

test('buildNotificationSequence uses OSC 9 for unknown terminals', (t) => {
  const seq = buildNotificationSequence('Title', 'Message', {});
  t.is(seq, '\x1b]9;Message\x07');
});

test('buildNotificationSequence uses OSC 777 for ghostty', (t) => {
  const seq = buildNotificationSequence('Alert', 'Done', { TERM_PROGRAM: 'ghostty' });
  t.is(seq, '\x1b]777;notify;Alert;Done\x07');
});

test('buildNotificationSequence uses OSC 777 for kitty (TERM=xterm-kitty)', (t) => {
  const seq = buildNotificationSequence('Alert', 'Done', { TERM: 'xterm-kitty' });
  t.is(seq, '\x1b]777;notify;Alert;Done\x07');
});

test('buildNotificationSequence uses OSC 777 for WezTerm', (t) => {
  const seq = buildNotificationSequence('T', 'M', { TERM_PROGRAM: 'WezTerm' });
  t.is(seq, '\x1b]777;notify;T;M\x07');
});

test('buildNotificationSequence uses OSC 777 for foot', (t) => {
  const seq = buildNotificationSequence('T', 'M', { TERM: 'foot' });
  t.is(seq, '\x1b]777;notify;T;M\x07');
});

test('buildNotificationSequence uses OSC 9 for iterm2', (t) => {
  const seq = buildNotificationSequence('T', 'M', { TERM_PROGRAM: 'iTerm.app' });
  t.is(seq, '\x1b]9;M\x07');
});

test('buildNotificationSequence uses OSC 9 for generic xterm', (t) => {
  const seq = buildNotificationSequence('T', 'M', { TERM: 'xterm-256color', TERM_PROGRAM: undefined });
  t.is(seq, '\x1b]9;M\x07');
});

// ── Sanitization ────────────────────────────────────────────────────────────

test('buildNotificationSequence strips semicolons from title and message', (t) => {
  const seq = buildNotificationSequence('Ti;tle', 'Me;ssage', { TERM_PROGRAM: 'ghostty' });
  t.is(seq, '\x1b]777;notify;Title;Message\x07');
});

test('buildNotificationSequence strips ESC characters from title and message', (t) => {
  const seq = buildNotificationSequence('Ti\x1btle', 'Me\x1bssage', { TERM_PROGRAM: 'ghostty' });
  t.is(seq, '\x1b]777;notify;Title;Message\x07');
});

test('buildNotificationSequence strips BEL characters from title and message', (t) => {
  const seq = buildNotificationSequence('Ti\x07tle', 'Me\x07ssage', { TERM_PROGRAM: 'ghostty' });
  t.is(seq, '\x1b]777;notify;Title;Message\x07');
});

test('buildNotificationSequence strips semicolons from OSC 9 message', (t) => {
  const seq = buildNotificationSequence('T', 'Me;ss;age', {});
  t.is(seq, '\x1b]9;Message\x07');
});

// ── sendNotification ────────────────────────────────────────────────────────

test('sendNotification writes OSC sequence to the injected writer', (t) => {
  let written = '';
  sendNotification('Alert', 'Done', {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.is(written, '\x1b]9;Done\x07');
});

test('sendNotification does nothing when no writer is available', (t) => {
  t.notThrows(() => {
    sendNotification('T', 'M', {
      env: {},
      getTtyWriter: () => null,
    });
  });
});

test('sendNotification applies OSC 777 for capable terminals', (t) => {
  let written = '';
  sendNotification('Alert', 'Done', {
    env: { TERM_PROGRAM: 'kitty' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.is(written, '\x1b]777;notify;Alert;Done\x07');
});
