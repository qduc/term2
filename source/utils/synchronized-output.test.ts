import test from 'ava';
import { patchStdoutForSynchronizedOutput, isSynchronizedOutputSupported } from './synchronized-output.js';
import { Writable } from 'stream';

test('isSynchronizedOutputSupported returns true', (t) => {
  t.true(isSynchronizedOutputSupported());
});

test('patchStdoutForSynchronizedOutput wraps string writes with sync markers', (t) => {
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

  t.is(chunks.length, 1);
  t.is(chunks[0], '\x1b[?2026hhello\x1b[?2026l');
});

test('patchStdoutForSynchronizedOutput passes through non-string writes', (t) => {
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

  t.is(chunks.length, 1);
  // Buffer writes should NOT be wrapped with sync markers
  t.deepEqual(chunks[0], buf);
});

test('patchStdoutForSynchronizedOutput handles nested writes without double-wrapping', (t) => {
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
  t.true(chunks.some((c) => c.includes('\x1b[?2026h')));
  // Nested call should NOT contain sync markers (double-wrapping prevented)
  t.is(chunks[1], 'nested');
});
