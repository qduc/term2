import test from 'ava';
import fs from 'fs';
import { wrapForMultiplexer, writeOscSequence, getTtyWriter } from './tty-osc.js';

// ── wrapForMultiplexer ──────────────────────────────────────────────────────

test('wrapForMultiplexer returns inner unchanged in a bare terminal', (t) => {
  const inner = '\x1b]9;hello\x07';
  t.is(wrapForMultiplexer(inner, {}), inner);
});

test('wrapForMultiplexer wraps in tmux DCS passthrough when TMUX is set', (t) => {
  const inner = '\x1b]9;hello\x07';
  const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
  const expected = `\x1bPtmux;\x1b${escaped}\x1b\\`;
  t.is(wrapForMultiplexer(inner, { TMUX: '/tmp/tmux' }), expected);
});

test('wrapForMultiplexer wraps in screen DCS passthrough when TERM starts with screen', (t) => {
  const inner = '\x1b]9;hi\x07';
  const expected = `\x1bP${inner}\x1b\\`;
  t.is(wrapForMultiplexer(inner, { TERM: 'screen-256color' }), expected);
});

test('wrapForMultiplexer chunks screen DCS passthrough at 768 characters', (t) => {
  // Create an inner sequence longer than 768 chars
  const longMsg = 'x'.repeat(800);
  const inner = `\x1b]9;${longMsg}\x07`;
  t.true(inner.length > 768, 'precondition: inner sequence must exceed 768 chars');

  const result = wrapForMultiplexer(inner, { TERM: 'screen' });
  const chunk1 = inner.slice(0, 768);
  const chunk2 = inner.slice(768);
  t.is(result, `\x1bP${chunk1}\x1b\\` + `\x1bP${chunk2}\x1b\\`);
});

// ── writeOscSequence ────────────────────────────────────────────────────────

test('writeOscSequence calls the injected writer with the bare sequence in a plain env', (t) => {
  let written = '';
  const inner = '\x1b]9;hello\x07';
  writeOscSequence(inner, {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.is(written, inner);
});

test('writeOscSequence does nothing when getTtyWriter returns null', (t) => {
  t.notThrows(() => {
    writeOscSequence('\x1b]9;test\x07', {
      env: {},
      getTtyWriter: () => null,
    });
  });
});

test('writeOscSequence applies tmux wrapping before writing', (t) => {
  let written = '';
  const inner = '\x1b]9;msg\x07';
  const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
  const expected = `\x1bPtmux;\x1b${escaped}\x1b\\`;

  writeOscSequence(inner, {
    env: { TMUX: '/tmp/tmux' },
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  t.is(written, expected);
});

test.serial('getTtyWriter returned writer opens and closes /dev/tty on each write', (t) => {
  const isTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });

  const openedFds: number[] = [];
  const closedFds: number[] = [];
  const writtenData: { fd: number; data: string }[] = [];
  let nextFd = 100;

  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalWrite = fs.writeSync;

  fs.openSync = ((path: any, flags: any) => {
    if (path === '/dev/tty') {
      const fd = nextFd++;
      openedFds.push(fd);
      return fd;
    }
    return originalOpen(path, flags);
  }) as any;

  fs.closeSync = ((fd: any) => {
    if (fd >= 100) {
      closedFds.push(fd);
      return;
    }
    return originalClose(fd);
  }) as any;

  fs.writeSync = ((fd: any, data: any) => {
    if (fd >= 100) {
      writtenData.push({ fd, data: String(data) });
      return data.length;
    }
    return originalWrite(fd, data);
  }) as any;

  try {
    const writer = getTtyWriter();
    t.truthy(writer);

    // First verification open/close on getTtyWriter call:
    t.is(openedFds.length, 1);
    t.is(closedFds.length, 1);
    t.is(openedFds[0], closedFds[0]);

    // Perform two writes:
    writer!('hello');
    writer!('world');

    // Should have opened and closed two more times
    t.is(openedFds.length, 3);
    t.is(closedFds.length, 3);

    t.is(writtenData.length, 2);
    t.is(writtenData[0].data, 'hello');
    t.is(writtenData[1].data, 'world');
    // Verify each write had its own fd opened and closed
    t.is(writtenData[0].fd, openedFds[1]);
    t.is(closedFds[1], openedFds[1]);
    t.is(writtenData[1].fd, openedFds[2]);
    t.is(closedFds[2], openedFds[2]);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.writeSync = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: isTty,
      configurable: true,
    });
  }
});
