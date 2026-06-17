import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { describeError, isAbortLikeError } from './error-helpers.js';

// Test isAbortLikeError with AbortError name
it('isAbortLikeError returns true for error with name AbortError', () => {
  const error = { name: 'AbortError', message: 'Operation aborted' };
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with ABORT_ERR code
it('isAbortLikeError returns true for error with code ABORT_ERR', () => {
  const error = { code: 'ABORT_ERR', message: 'Aborted' };
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with abort in message
it('isAbortLikeError returns true for error with "abort" in message', () => {
  const error = new Error('The operation was aborted');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for error with "Abort" (capitalized) in message', () => {
  const error = new Error('Abort requested');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with cancel in message
it('isAbortLikeError returns true for error with "cancel" in message', () => {
  const error = new Error('Request was cancelled');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for error with "Cancel" (capitalized) in message', () => {
  const error = new Error('Cancel operation');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with user cancelled variations
it('isAbortLikeError returns true for "user cancelled"', () => {
  const error = new Error('user cancelled the operation');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "user-cancelled"', () => {
  const error = new Error('user-cancelled');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "User Cancelled"', () => {
  const error = new Error('User Cancelled');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with user aborted variations
it('isAbortLikeError returns true for "user aborted"', () => {
  const error = new Error('user aborted the request');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "user-aborted"', () => {
  const error = new Error('user-aborted');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError with operation aborted/cancelled
it('isAbortLikeError returns true for "operation aborted"', () => {
  const error = new Error('operation aborted by user');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "operation-aborted"', () => {
  const error = new Error('operation-aborted');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "operation cancelled"', () => {
  const error = new Error('operation cancelled');
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for "operation-cancelled"', () => {
  const error = new Error('operation-cancelled');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test isAbortLikeError returns false for regular errors
it('isAbortLikeError returns false for regular error', () => {
  const error = new Error('Something went wrong');
  expect(isAbortLikeError(error)).toBe(false);
});

it('isAbortLikeError returns false for network error', () => {
  const error = new Error('Network timeout');
  expect(isAbortLikeError(error)).toBe(false);
});

it('isAbortLikeError returns false for null', () => {
  expect(isAbortLikeError(null)).toBe(false);
});

it('isAbortLikeError returns false for undefined', () => {
  expect(isAbortLikeError(undefined)).toBe(false);
});

it('isAbortLikeError returns false for empty string', () => {
  expect(isAbortLikeError('')).toBe(false);
});

it('isAbortLikeError returns false for error with empty message', () => {
  const error = new Error('');
  expect(isAbortLikeError(error)).toBe(false);
});

it('isAbortLikeError returns false for generic object', () => {
  const error = { message: 'Some error', code: 500 };
  expect(isAbortLikeError(error)).toBe(false);
});

// Test edge cases - verify no false positives with similar words
it('isAbortLikeError returns false for "elaborate" (does not contain "abort")', () => {
  const error = new Error('Please elaborate on this');
  expect(isAbortLikeError(error)).toBe(false);
});

it('isAbortLikeError returns true for "cancellation" (contains "cancel")', () => {
  const error = new Error('Cancellation policy applies');
  expect(isAbortLikeError(error)).toBe(true);
});

// Test with DOMException (typical browser AbortError)
it('isAbortLikeError returns true for DOMException with AbortError name', () => {
  const error = {
    name: 'AbortError',
    message: 'The user aborted a request',
    code: 20,
  };
  expect(isAbortLikeError(error)).toBe(true);
});

// Test combination of properties
it('isAbortLikeError returns true when both name and message indicate abort', () => {
  const error = {
    name: 'AbortError',
    message: 'Operation cancelled by user',
  };
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns true for Error with ABORT_ERR code and abort message', () => {
  const error = {
    name: 'Error',
    code: 'ABORT_ERR',
    message: 'Abort signal received',
  };
  expect(isAbortLikeError(error)).toBe(true);
});

// Test string errors (non-Error objects)
it('isAbortLikeError returns true for string containing "abort"', () => {
  expect(isAbortLikeError('abort')).toBe(true);
});

it('isAbortLikeError returns true for string "user cancelled"', () => {
  expect(isAbortLikeError('user cancelled')).toBe(true);
});

it('isAbortLikeError returns false for string without abort keywords', () => {
  expect(isAbortLikeError('some error message')).toBe(false);
});

it('isAbortLikeError returns true for undici TypeError: terminated with AbortError cause', () => {
  const error = Object.assign(new TypeError('terminated'), {
    cause: { name: 'AbortError', message: 'The operation was aborted' },
  });
  expect(isAbortLikeError(error)).toBe(true);
});

it('isAbortLikeError returns false for TypeError: terminated without abort-like cause', () => {
  const error = Object.assign(new TypeError('terminated'), {
    cause: { name: 'SocketError', message: 'socket hang up' },
  });
  expect(isAbortLikeError(error)).toBe(false);
});

it('describeError includes nested cause when top-level fetch error is generic', () => {
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
  });

  expect(describeError(error)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
});

it('describeError keeps specific top-level error without repeating the same cause', () => {
  const error = Object.assign(new Error('socket hang up'), {
    cause: new Error('socket hang up'),
  });

  expect(describeError(error)).toBe('socket hang up');
});

it('describeError surfaces undici onSocketClose as a connection drop', () => {
  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const described = describeError(undiciSocketClose);
  expect(described.toLowerCase().includes('connection')).toBe(true);
  expect(described === 'TypeError').toBe(false);
});

it('describeError surfaces re-wrapped undici onSocketClose (Error with message "TypeError") as a connection drop', () => {
  const rewrapped = new Error('TypeError');
  rewrapped.stack = [
    'Error: TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const described = describeError(rewrapped);
  expect(described.toLowerCase().includes('connection')).toBe(true);
  expect(described === 'TypeError').toBe(false);
});

it('describeError does not misidentify plain Error with message "TypeError" as undici socket close', () => {
  const plain = new Error('TypeError');
  plain.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';

  const described = describeError(plain);
  expect(described).toBe('TypeError');
});
