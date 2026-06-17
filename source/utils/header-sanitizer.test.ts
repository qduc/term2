import { it, expect } from 'vitest';
import { sanitizeHeaders } from './header-sanitizer.js';

it('sanitizeHeaders returns undefined for empty input', () => {
  expect(sanitizeHeaders(undefined)).toBe(undefined);
  expect(sanitizeHeaders(null as any)).toBe(undefined);
});

it('sanitizeHeaders handles Record<string, string> and case-insensitive redactions', () => {
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
  expect(result).toEqual(expected);
});

it('sanitizeHeaders handles Array of pairs', () => {
  const input: [string, string][] = [
    ['Authorization', 'Bearer 12345'],
    ['Accept', 'text/html'],
  ];

  const expected = {
    authorization: '[REDACTED]',
    accept: 'text/html',
  };

  const result = sanitizeHeaders(input);
  expect(result).toEqual(expected);
});

it('sanitizeHeaders handles Headers instance if available', () => {
  if (typeof Headers === 'undefined') {
    expect(true).toBe(true);
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
  expect(result).toEqual(expected);
});
