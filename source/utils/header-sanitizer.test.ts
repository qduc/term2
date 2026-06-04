import test from 'ava';
import { sanitizeHeaders } from './header-sanitizer.js';

test('sanitizeHeaders returns undefined for empty input', (t) => {
  t.is(sanitizeHeaders(undefined), undefined);
  t.is(sanitizeHeaders(null as any), undefined);
});

test('sanitizeHeaders handles Record<string, string> and case-insensitive redactions', (t) => {
  const input = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret-token-123',
    'x-api-key': 'secret-key-abc',
    'X-Goog-Api-Key': 'secret-goog-api-key',
    cookie: 'session=abc; token=def',
    'x-opencode-session': 'session-safe-id-789',
    'HTTP-Referer': 'https://github.com/qduc/term2',
  };

  const expected = {
    'content-type': 'application/json',
    authorization: '[REDACTED]',
    'x-api-key': '[REDACTED]',
    'x-goog-api-key': '[REDACTED]',
    cookie: '[REDACTED]',
    'x-opencode-session': 'session-safe-id-789',
    'http-referer': 'https://github.com/qduc/term2',
  };

  const result = sanitizeHeaders(input);
  t.deepEqual(result, expected);
});

test('sanitizeHeaders handles Array of pairs', (t) => {
  const input: [string, string][] = [
    ['Authorization', 'Bearer 12345'],
    ['Accept', 'text/html'],
  ];

  const expected = {
    authorization: '[REDACTED]',
    accept: 'text/html',
  };

  const result = sanitizeHeaders(input);
  t.deepEqual(result, expected);
});

test('sanitizeHeaders handles Headers instance if available', (t) => {
  if (typeof Headers === 'undefined') {
    t.pass('Headers not defined in environment');
    return;
  }

  const headers = new Headers();
  headers.append('Authorization', 'Bearer 54321');
  headers.append('X-Custom-Header', 'custom-value');

  const expected = {
    authorization: '[REDACTED]',
    'x-custom-header': 'custom-value',
  };

  const result = sanitizeHeaders(headers);
  t.deepEqual(result, expected);
});
