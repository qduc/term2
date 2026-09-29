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
  assert.throws(
    () => assertLocalStateChangingRequest(request({ 'content-type': 'application/json', host: 'evil.test@localhost' })),
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
  assert.throws(
    () =>
      assertLocalStateChangingRequest(
        request({ 'content-type': 'application/json', host: 'localhost', origin: 'http://evil.test@localhost' }),
      ),
    /origin/i,
  );
});

test('only allows loopback hosts when the LAN opt-in is unset or empty', () => {
  const previous = process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS;
  try {
    delete process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS;
    assert.throws(
      () =>
        assertLocalStateChangingRequest(
          request({ 'content-type': 'application/json', host: '192.168.1.20', origin: 'http://192.168.1.20' }),
        ),
      /host/i,
    );
    process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS = ' , ';
    assert.throws(
      () => assertLocalStateChangingRequest(request({ 'content-type': 'application/json', host: '192.168.1.20' })),
      /host/i,
    );
  } finally {
    if (previous === undefined) delete process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS;
    else process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS = previous;
  }
});

test('allows configured LAN hostnames for both Host and Origin only', () => {
  const previous = process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS;
  try {
    process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS = '192.168.1.20, workstation.local';
    assert.doesNotThrow(() =>
      assertLocalStateChangingRequest(
        request({
          'content-type': 'application/json',
          host: '192.168.1.20:3210',
          origin: 'http://workstation.local:3210',
        }),
      ),
    );
    assert.throws(
      () =>
        assertLocalStateChangingRequest(
          request({ 'content-type': 'application/json', host: '192.168.1.20', origin: 'http://evil.test' }),
        ),
      /origin/i,
    );
  } finally {
    if (previous === undefined) delete process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS;
    else process.env.TERM2_WEB_CLIENT_ALLOWED_HOSTS = previous;
  }
});
