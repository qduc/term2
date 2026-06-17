import { it, expect } from 'vitest';
import { patchStdoutForSynchronizedOutput, isSynchronizedOutputSupported } from './synchronized-output.js';
import { Writable } from 'stream';

it('isSynchronizedOutputSupported returns true', () => {
  expect(isSynchronizedOutputSupported()).toBe(true);
});

it('patchStdoutForSynchronizedOutput wraps string writes with sync markers', () => {
  const chunks: string[] = [];
  const fakeStream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as any;

  // Add columns property to mimic a WriteStream
  fakeStream.columns = 80;

  patchStdoutForSynchronizedOutput(fakeStream);

  fakeStream.write('hello');

  expect(chunks.length).toBe(1);
  expect(chunks[0]).toBe('\x1b[?2026hhello\x1b[?2026l');
});

it('patchStdoutForSynchronizedOutput passes through non-string writes', () => {
  const chunks: Buffer[] = [];
  const fakeStream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as any;

  fakeStream.columns = 80;

  patchStdoutForSynchronizedOutput(fakeStream);

  const buf = Buffer.from([0x01, 0x02, 0x03]);
  fakeStream.write(buf);

  expect(chunks.length).toBe(1);
  // Buffer writes should NOT be wrapped with sync markers
  expect(chunks[0]).toEqual(buf);
});

it('patchStdoutForSynchronizedOutput handles nested writes without double-wrapping', () => {
  const chunks: string[] = [];
  let writeImpl: (chunk: any, encoding?: any, callback?: any) => boolean;

  const fakeStream = {
    columns: 80,
    write(chunk: any, encoding?: any, callback?: any) {
      return writeImpl(chunk, encoding, callback);
    },
  } as any;

  writeImpl = (chunk: any, _encoding?: any, _callback?: any) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  patchStdoutForSynchronizedOutput(fakeStream);

  // Save the patched write
  const patchedWrite = fakeStream.write;

  // Simulate a nested write (e.g., Ink calling clear then write in sequence)
  writeImpl = (chunk: any, _encoding?: any, _callback?: any) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    // Simulate a nested write during the original write
    if (chunks.length === 1) {
      patchedWrite.call(fakeStream, 'nested');
    }
    return true;
  };

  fakeStream.write('outer');

  // The outer write should be wrapped, and the nested write should also be
  // handled (not double-wrapped since syncing flag is set)
  expect(chunks.some((c) => c.includes('\x1b[?2026h'))).toBe(true);
  // Nested call should NOT contain sync markers (double-wrapping prevented)
  expect(chunks[1]).toBe('nested');
});
