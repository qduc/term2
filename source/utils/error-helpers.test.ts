import test from 'ava';
import {isAbortLikeError} from './error-helpers.js';

// Test isAbortLikeError with AbortError name
test('isAbortLikeError returns true for error with name AbortError', t => {
	const error = {name: 'AbortError', message: 'Operation aborted'};
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with ABORT_ERR code
test('isAbortLikeError returns true for error with code ABORT_ERR', t => {
	const error = {code: 'ABORT_ERR', message: 'Aborted'};
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with abort in message
test('isAbortLikeError returns true for error with "abort" in message', t => {
	const error = new Error('The operation was aborted');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for error with "Abort" (capitalized) in message', t => {
	const error = new Error('Abort requested');
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with cancel in message
test('isAbortLikeError returns true for error with "cancel" in message', t => {
	const error = new Error('Request was cancelled');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for error with "Cancel" (capitalized) in message', t => {
	const error = new Error('Cancel operation');
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with user cancelled variations
test('isAbortLikeError returns true for "user cancelled"', t => {
	const error = new Error('user cancelled the operation');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "user-cancelled"', t => {
	const error = new Error('user-cancelled');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "User Cancelled"', t => {
	const error = new Error('User Cancelled');
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with user aborted variations
test('isAbortLikeError returns true for "user aborted"', t => {
	const error = new Error('user aborted the request');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "user-aborted"', t => {
	const error = new Error('user-aborted');
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError with operation aborted/cancelled
test('isAbortLikeError returns true for "operation aborted"', t => {
	const error = new Error('operation aborted by user');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation-aborted"', t => {
	const error = new Error('operation-aborted');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation cancelled"', t => {
	const error = new Error('operation cancelled');
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "operation-cancelled"', t => {
	const error = new Error('operation-cancelled');
	t.true(isAbortLikeError(error));
});

// Test isAbortLikeError returns false for regular errors
test('isAbortLikeError returns false for regular error', t => {
	const error = new Error('Something went wrong');
	t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for network error', t => {
	const error = new Error('Network timeout');
	t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for null', t => {
	t.false(isAbortLikeError(null));
});

test('isAbortLikeError returns false for undefined', t => {
	t.false(isAbortLikeError(undefined));
});

test('isAbortLikeError returns false for empty string', t => {
	t.false(isAbortLikeError(''));
});

test('isAbortLikeError returns false for error with empty message', t => {
	const error = new Error('');
	t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns false for generic object', t => {
	const error = {message: 'Some error', code: 500};
	t.false(isAbortLikeError(error));
});

// Test edge cases - verify no false positives with similar words
test('isAbortLikeError returns false for "elaborate" (does not contain "abort")', t => {
	const error = new Error('Please elaborate on this');
	t.false(isAbortLikeError(error));
});

test('isAbortLikeError returns true for "cancellation" (contains "cancel")', t => {
	const error = new Error('Cancellation policy applies');
	t.true(isAbortLikeError(error));
});

// Test with DOMException (typical browser AbortError)
test('isAbortLikeError returns true for DOMException with AbortError name', t => {
	const error = {
		name: 'AbortError',
		message: 'The user aborted a request',
		code: 20,
	};
	t.true(isAbortLikeError(error));
});

// Test combination of properties
test('isAbortLikeError returns true when both name and message indicate abort', t => {
	const error = {
		name: 'AbortError',
		message: 'Operation cancelled by user',
	};
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns true for Error with ABORT_ERR code and abort message', t => {
	const error = {
		name: 'Error',
		code: 'ABORT_ERR',
		message: 'Abort signal received',
	};
	t.true(isAbortLikeError(error));
});

// Test string errors (non-Error objects)
test('isAbortLikeError returns true for string containing "abort"', t => {
	t.true(isAbortLikeError('abort'));
});

test('isAbortLikeError returns true for string "user cancelled"', t => {
	t.true(isAbortLikeError('user cancelled'));
});

test('isAbortLikeError returns false for string without abort keywords', t => {
	t.false(isAbortLikeError('some error message'));
});

test('isAbortLikeError returns true for undici TypeError: terminated with AbortError cause', t => {
	const error = Object.assign(new TypeError('terminated'), {
		cause: {name: 'AbortError', message: 'The operation was aborted'},
	});
	t.true(isAbortLikeError(error));
});

test('isAbortLikeError returns false for TypeError: terminated without abort-like cause', t => {
	const error = Object.assign(new TypeError('terminated'), {
		cause: {name: 'SocketError', message: 'socket hang up'},
	});
	t.false(isAbortLikeError(error));
});
