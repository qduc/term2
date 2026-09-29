import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalStateChangingRequest } from './request-guards.js';

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/test', { method: 'POST', headers, body: '{}' });
}

test('requires JSON content type and local host', () => {
  assert.doesNotThrow(() =>
    assertLocalStateChangingRequest(request({ 'content-type': 'Application/JSON; charset=utf-8', host: 'localhost:3210' })),
  );
  assert.throws(() => assertLocalStateChangingRequest(request({ host: 'localhost' })), /content-type/i);
  assert.throws(
    () => assertLocalStateChangingRequest(request({ 'content-type': 'application/json', host: 'evil.test' })),
    /host/i,
  );
});

test('allows missing origin and rejects non-local origins', () => {
  assert.doesNotThrow(() =>
    assertLocalStateChangingRequest(request({ 'content-type': 'application/json', host: '127.0.0.1:3210' })),
  );
  assert.doesNotThrow(() =>
    assertLocalStateChangingRequest(
      request({ 'content-type': 'application/json', host: 'localhost', origin: 'http://127.0.0.1:9999' }),
    ),
  );
  assert.throws(
    () =>
      assertLocalStateChangingRequest(
        request({ 'content-type': 'application/json', host: 'localhost', origin: 'https://evil.test' }),
      ),
    /origin/i,
  );
});
