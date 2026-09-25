import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets } from './secret-redaction.js';

// Fixture values are synthetic and only shaped like credentials.
const cases: Array<[string, string]> = [
  ['OpenAI-style key', 'use sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 for the test'],
  ['Anthropic-style key', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['GitHub token', 'token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['AWS access key id', 'AKIAABCDEFGHIJKLMNOP is the id'],
  ['Slack token', ['xoxb', '123456789012-123456789012-AbCdEfGhIjKlMnOp'].join('-')],
  ['bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ['assignment', 'OPENROUTER_API_KEY=abcdefghijklmnop0123456789'],
  ['password assignment', 'password: "correct horse battery staple"'],
  ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\n-----END OPENSSH PRIVATE KEY-----'],
  ['url credentials', 'clone https://user:hunter2secret@example.com/repo.git'],
];

describe('secret redaction', () => {
  it.each(cases)('redacts a %s', (_label, text) => {
    const redacted = redactSecrets(text);
    expect(redacted).toContain('[REDACTED]');
    expect(containsSecret(text)).toBe(true);
    expect(containsSecret(redacted)).toBe(false);
  });

  it('leaves ordinary engineering prose alone', () => {
    const prose =
      'We decided to keep the WebSocket transport; the token budget is 8000 chars and the key insight is caching. See commit 65c61934 and sha256 8a49311f9af4.';
    expect(redactSecrets(prose)).toBe(prose);
    expect(containsSecret(prose)).toBe(false);
  });
});
