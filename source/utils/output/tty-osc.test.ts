import { it, expect } from 'vitest';
import fs from 'fs';
import { wrapForMultiplexer, writeOscSequence, getTtyWriter } from './tty-osc.js';

// ── wrapForMultiplexer ──────────────────────────────────────────────────────

it('wrapForMultiplexer returns inner unchanged in a bare terminal', () => {
  const inner = '\x1b]9;hello\x07';
  expect(wrapForMultiplexer(inner, {})).toBe(inner);
});

it('wrapForMultiplexer wraps in tmux DCS passthrough when TMUX is set', () => {
  const inner = '\x1b]9;hello\x07';
  const escaped = inner.replace(/\x1b/g, '\x1b\x1b');
  const expected = `\x1bPtmux;\x1b${escaped}\x1b\\`;
  expect(wrapForMultiplexer(inner, { TMUX: '/tmp/tmux' })).toBe(expected);
});

it('wrapForMultiplexer wraps in screen DCS passthrough when TERM starts with screen', () => {
  const inner = '\x1b]9;hi\x07';
  const expected = `\x1bP${inner}\x1b\\`;
  expect(wrapForMultiplexer(inner, { TERM: 'screen-256color' })).toBe(expected);
});

it('wrapForMultiplexer chunks screen DCS passthrough at 768 characters', () => {
  // Create an inner sequence longer than 768 chars
  const longMsg = 'x'.repeat(800);
  const inner = `\x1b]9;${longMsg}\x07`;
  expect(inner.length > 768).toBe(true);

  const result = wrapForMultiplexer(inner, { TERM: 'screen' });
  const chunk1 = inner.slice(0, 768);
  const chunk2 = inner.slice(768);
  expect(result).toBe(`\x1bP${chunk1}\x1b\\` + `\x1bP${chunk2}\x1b\\`);
});

// ── writeOscSequence ────────────────────────────────────────────────────────

it('writeOscSequence calls the injected writer with the bare sequence in a plain env', () => {
  let written = '';
  const inner = '\x1b]9;hello\x07';
  writeOscSequence(inner, {
    env: {},
    getTtyWriter: () => (data) => {
      written = data;
    },
  });
  expect(written).toBe(inner);
});

it('writeOscSequence does nothing when getTtyWriter returns null', () => {
  expect(() => {
    writeOscSequence('\x1b]9;test\x07', {
      env: {},
      getTtyWriter: () => null,
    });
  });
});

it('writeOscSequence applies tmux wrapping before writing', () => {
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
  expect(written).toBe(expected);
});

it.sequential('getTtyWriter returned writer opens and closes /dev/tty on each write', () => {
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
    expect(writer).toBeTruthy();

    // First verification open/close on getTtyWriter call:
    expect(openedFds.length).toBe(1);
    expect(closedFds.length).toBe(1);
    expect(openedFds[0]).toBe(closedFds[0]);

    // Perform two writes:
    writer!('hello');
    writer!('world');

    // Should have opened and closed two more times
    expect(openedFds.length).toBe(3);
    expect(closedFds.length).toBe(3);

    expect(writtenData.length).toBe(2);
    expect(writtenData[0].data).toBe('hello');
    expect(writtenData[1].data).toBe('world');
    // Verify each write had its own fd opened and closed
    expect(writtenData[0].fd).toBe(openedFds[1]);
    expect(closedFds[1]).toBe(openedFds[1]);
    expect(writtenData[1].fd).toBe(openedFds[2]);
    expect(closedFds[2]).toBe(openedFds[2]);
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
