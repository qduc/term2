import { it, expect } from 'vitest';
import { webSocketCloseError, findWebSocketClosedEarly } from './websocket-close-evidence.js';
import { UnsentWebSocketRequestError } from './websocket-request-dispatch.js';
import { isRecoverableIncompleteStreamClose } from '../services/retry/retry-error-classification.js';

it('a close after the frame was flushed carries its code and reason into the message', () => {
  const error = webSocketCloseError({ type: 'close', code: 1006, reason: '', unsent: [] }, 'flushed');

  expect(error).not.toBeInstanceOf(UnsentWebSocketRequestError);
  // The retry classifier reads the close code out of the message text, and the
  // app and traffic logs record only the message.
  expect(error.message).toContain('closed before a terminal response event');
  expect(error.message).toContain('code=1006');
  expect(findWebSocketClosedEarly(error)?.closeCode).toBe(1006);
  expect(isRecoverableIncompleteStreamClose(error)).toBe(true);
});

it('a deliberate server close stays out of the recoverable set', () => {
  const error = webSocketCloseError({ type: 'close', code: 1008, reason: 'policy', unsent: [] }, 'flushed');

  expect(error.message).toContain('code=1008');
  expect(isRecoverableIncompleteStreamClose(error)).toBe(false);
});

it('a close that left the request frame queued is provably unsent', () => {
  const error = webSocketCloseError({ type: 'close', code: 1006, unsent: [{ type: 'response.create' }] }, 'flushed');

  expect(error).toBeInstanceOf(UnsentWebSocketRequestError);
  // The evidence survives the wrapper so the close code is still loggable.
  expect(findWebSocketClosedEarly(error)?.closeCode).toBe(1006);
  expect(findWebSocketClosedEarly(error)?.unsentCount).toBe(1);
});

it('a close before the frame reached an open socket is provably unsent', () => {
  const error = webSocketCloseError({ type: 'close', code: 1006 }, 'unsent');

  expect(error).toBeInstanceOf(UnsentWebSocketRequestError);
});

it('a close the send path could not observe stays ambiguous', () => {
  const error = webSocketCloseError({ type: 'close', code: 1006 }, 'unknown');

  expect(error).not.toBeInstanceOf(UnsentWebSocketRequestError);
});

it('a close frame with no code is described without inventing one', () => {
  const error = webSocketCloseError({ type: 'close' }, 'flushed');

  expect(error.message).toContain('code=unknown');
  // No code means no evidence of a deliberate close, so recovery is allowed.
  expect(isRecoverableIncompleteStreamClose(error)).toBe(true);
});
