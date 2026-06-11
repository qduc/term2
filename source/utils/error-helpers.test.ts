import test from 'ava';
import { describeError, isAbortLikeError } from './error-helpers.js';

// Test isAbortLikeError with AbortError name
test('isAbortLikeError returns true for error with name AbortError', (t) => {
  const error = { name: 'AbortError', message: 'Operation aborted' };
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with ABORT_ERR code
test('isAbortLikeError returns true for error with code ABORT_ERR', (t) => {
  const error = { code: 'ABORT_ERR', message: 'Aborted' };
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with abort in message
test('isAbortLikeError returns true for error with "abort" in message', (t) => {
  const error = new Error('The operation was aborted');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for error with "Abort" (capitalized) in message', (t) => {
  const error = new Error('Abort requested');
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with cancel in message
test('isAbortLikeError returns true for error with "cancel" in message', (t) => {
  const error = new Error('Request was cancelled');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for error with "Cancel" (capitalized) in message', (t) => {
  const error = new Error('Cancel operation');
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with user cancelled variations
test('isAbortLikeError returns true for "user cancelled"', (t) => {
  const error = new Error('user cancelled the operation');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "user-cancelled"', (t) => {
  const error = new Error('user-cancelled');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "User Cancelled"', (t) => {
  const error = new Error('User Cancelled');
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with user aborted variations
test('isAbortLikeError returns true for "user aborted"', (t) => {
  const error = new Error('user aborted the request');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "user-aborted"', (t) => {
  const error = new Error('user-aborted');
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with operation aborted/cancelled
test('isAbortLikeError returns true for "operation aborted"', (t) => {
  const error = new Error('operation aborted by user');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation-aborted"', (t) => {
  const error = new Error('operation-aborted');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation cancelled"', (t) => {
  const error = new Error('operation cancelled');
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation-cancelled"', (t) => {
  const error = new Error('operation-cancelled');
  t.true(isAbortLikeError(error));
});

// Test isAbortLikeError returns false for regular errors
test('isAbortLikeError returns false for regular error', (t) => {
  const error = new Error('Something went wrong');
  t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for network error', (t) => {
  const error = new Error('Network timeout');
  t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for null', (t) => {
  t.false(isAbortLikeError(null));
});

test('isAbortLikeError returns false for undefined', (t) => {
  t.false(isAbortLikeError(undefined));
});

test('isAbortLikeError returns false for empty string', (t) => {
  t.false(isAbortLikeError(''));
});

test('isAbortLikeError returns false for error with empty message', (t) => {
  const error = new Error('');
  t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for generic object', (t) => {
  const error = { message: 'Some error', code: 500 };
  t.false(isAbortLikeError(error));
});

// Test edge cases - verify no false positives with similar words
test('isAbortLikeError returns false for "elaborate" (does not contain "abort")', (t) => {
  const error = new Error('Please elaborate on this');
  t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "cancellation" (contains "cancel")', (t) => {
  const error = new Error('Cancellation policy applies');
  t.true(isAbortLikeError(error));
});

// Test with DOMException (typical browser AbortError)
test('isAbortLikeError returns true for DOMException with AbortError name', (t) => {
  const error = {
    name: 'AbortError',
    message: 'The user aborted a request',
    code: 20,
  };
  t.true(isAbortLikeError(error));
});

// Test combination of properties
test('isAbortLikeError returns true when both name and message indicate abort', (t) => {
  const error = {
    name: 'AbortError',
    message: 'Operation cancelled by user',
  };
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for Error with ABORT_ERR code and abort message', (t) => {
  const error = {
    name: 'Error',
    code: 'ABORT_ERR',
    message: 'Abort signal received',
  };
  t.true(isAbortLikeError(error));
});

// Test string errors (non-Error objects)
test('isAbortLikeError returns true for string containing "abort"', (t) => {
  t.true(isAbortLikeError('abort'));
});

test('isAbortLikeError returns true for string "user cancelled"', (t) => {
  t.true(isAbortLikeError('user cancelled'));
});

test('isAbortLikeError returns false for string without abort keywords', (t) => {
  t.false(isAbortLikeError('some error message'));
});

test('isAbortLikeError returns true for undici TypeError: terminated with AbortError cause', (t) => {
  const error = Object.assign(new TypeError('terminated'), {
    cause: { name: 'AbortError', message: 'The operation was aborted' },
  });
  t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns false for TypeError: terminated without abort-like cause', (t) => {
  const error = Object.assign(new TypeError('terminated'), {
    cause: { name: 'SocketError', message: 'socket hang up' },
  });
  t.false(isAbortLikeError(error));
});

test('describeError includes nested cause when top-level fetch error is generic', (t) => {
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
  });

  t.is(describeError(error), 'fetch failed: connect ECONNREFUSED 127.0.0.1:443');
});

test('describeError keeps specific top-level error without repeating the same cause', (t) => {
  const error = Object.assign(new Error('socket hang up'), {
    cause: new Error('socket hang up'),
  });

  t.is(describeError(error), 'socket hang up');
});

test('describeError surfaces undici onSocketClose as a connection drop', (t) => {
  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const described = describeError(undiciSocketClose);
  t.true(described.toLowerCase().includes('connection'));
  t.false(described === 'TypeError');
});

test('describeError surfaces re-wrapped undici onSocketClose (Error with message "TypeError") as a connection drop', (t) => {
  const rewrapped = new Error('TypeError');
  rewrapped.stack = [
    'Error: TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');

  const described = describeError(rewrapped);
  t.true(described.toLowerCase().includes('connection'));
  t.false(described === 'TypeError');
});

test('describeError does not misidentify plain Error with message "TypeError" as undici socket close', (t) => {
  const plain = new Error('TypeError');
  plain.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';

  const described = describeError(plain);
  t.is(described, 'TypeError');
});
