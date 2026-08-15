import { expect, it } from 'vitest';
import { readWebSocketDispatch, recordWebSocketDispatch } from './websocket-request-dispatch.js';

// Fail-closed default: a send path that never recorded anything must not be
// mistaken for proof that the request stayed on the client.
it('reads an unrecorded request as unknown rather than unsent', () => {
  expect(readWebSocketDispatch({})).toBe('unknown');
});

it('reads back the state the send path recorded', () => {
  const unsent = {};
  const flushed = {};
  recordWebSocketDispatch(unsent, 'unsent');
  recordWebSocketDispatch(flushed, 'flushed');

  expect(readWebSocketDispatch(unsent)).toBe('unsent');
  expect(readWebSocketDispatch(flushed)).toBe('flushed');
});

it('lets a later observation supersede an earlier one for the same request', () => {
  const request = {};
  recordWebSocketDispatch(request, 'unsent');
  recordWebSocketDispatch(request, 'flushed');

  expect(readWebSocketDispatch(request)).toBe('flushed');
});
