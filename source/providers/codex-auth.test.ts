import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_REDIRECT_URI,
  CODEX_TOKEN_ENDPOINT,
  loginToCodex,
  readCodexCliTokens,
  readStoredCodexTokens,
  saveCodexTokens,
} from './codex-auth.js';

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-')), name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('codex token storage', () => {
  it('round-trips stored tokens with owner-only permissions', () => {
    const file = tmpFile('codex-auth.json');
    saveCodexTokens({ access_token: 'a', refresh_token: 'r', id_token: 'i' }, file);

    expect(readStoredCodexTokens(file)).toMatchObject({ access_token: 'a', refresh_token: 'r', id_token: 'i' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('imports the codex CLI access token but never its refresh token', () => {
    // Carrying the CLI's refresh token would make term2 a second writer on one
    // rotation chain, silently logging the CLI out. Import is access-only.
    const file = tmpFile('auth.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: {
          access_token: 'access-from-cli',
          refresh_token: 'refresh-from-cli',
          id_token: 'id-from-cli',
          account_id: 'acct',
        },
      }),
    );

    expect(readCodexCliTokens(file)).toEqual({
      access_token: 'access-from-cli',
      id_token: 'id-from-cli',
      account_id: 'acct',
      imported: true,
    });
  });

  it('returns null rather than throwing for an unreadable store', () => {
    expect(readStoredCodexTokens(tmpFile('missing.json'))).toBeNull();
    expect(readCodexCliTokens(tmpFile('missing.json'))).toBeNull();
  });
});

describe('loginToCodex', () => {
  it('completes the PKCE flow and stores the exchanged tokens', async () => {
    const file = tmpFile('codex-auth.json');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'issued', refresh_token: 'r', id_token: 'i' }));

    let authorizeUrl = '';
    const login = loginToCodex({
      authPath: file,
      fetchImpl: fetchImpl as any,
      openBrowser: () => {},
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    // Play the authorization server: redirect back with the state we were given.
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    const requested = new URL(authorizeUrl);
    expect(requested.searchParams.get('code_challenge_method')).toBe('S256');
    expect(requested.searchParams.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
    expect(requested.searchParams.get('id_token_add_organizations')).toBe('true');

    const callback = new URL(CODEX_REDIRECT_URI);
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', requested.searchParams.get('state')!);
    await fetch(callback);

    await expect(login).resolves.toMatchObject({ access_token: 'issued', refresh_token: 'r' });
    expect(fetchImpl.mock.calls[0][0]).toBe(CODEX_TOKEN_ENDPOINT);
    expect(readStoredCodexTokens(file)).toMatchObject({ access_token: 'issued' });
  });

  it('rejects a callback whose state does not match the request', async () => {
    const login = loginToCodex({
      authPath: tmpFile('codex-auth.json'),
      fetchImpl: vi.fn() as any,
      openBrowser: () => {},
      onPrompt: () => {},
    });
    const failure = expect(login).rejects.toThrow(/state mismatch/);

    const callback = new URL(CODEX_REDIRECT_URI);
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', 'not-the-state-we-sent');
    await fetch(callback);

    await failure;
  });
});
