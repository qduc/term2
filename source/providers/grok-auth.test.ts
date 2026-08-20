import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GROK_REDIRECT_URI,
  GROK_TOKEN_ENDPOINT,
  GrokTokenManager,
  loginToGrok,
  readGrokCliTokens,
  readStoredGrokTokens,
  saveGrokTokens,
} from './grok-auth.js';

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-')), name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('grok token storage', () => {
  it('round-trips stored tokens with owner-only permissions', () => {
    const file = tmpFile('grok-auth.json');
    saveGrokTokens({ access_token: 'a', refresh_token: 'r', expires_at: 123 }, file);

    expect(readStoredGrokTokens(file)).toMatchObject({ access_token: 'a', refresh_token: 'r', expires_at: 123 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reads the grok CLI store, preferring an entry that carries a refresh token', () => {
    const file = tmpFile('auth.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        'https://auth.x.ai::other': { key: 'no-refresh' },
        'https://auth.x.ai::client': {
          key: 'access-from-cli',
          refresh_token: 'refresh-from-cli',
          expires_at: '2026-08-20T18:59:56Z',
          email: 'user@example.com',
        },
      }),
    );

    expect(readGrokCliTokens(file)).toEqual({
      access_token: 'access-from-cli',
      refresh_token: 'refresh-from-cli',
      expires_at: Date.parse('2026-08-20T18:59:56Z'),
      email: 'user@example.com',
      user_id: undefined,
      team_id: undefined,
    });
  });

  it('returns null rather than throwing for an unreadable store', () => {
    expect(readStoredGrokTokens(tmpFile('missing.json'))).toBeNull();
    expect(readGrokCliTokens(tmpFile('missing.json'))).toBeNull();
  });
});

describe('GrokTokenManager', () => {
  it('uses the stored access token while it is still fresh', async () => {
    const file = tmpFile('grok-auth.json');
    saveGrokTokens({ access_token: 'fresh', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }, file);
    const fetchImpl = vi.fn();

    const manager = new GrokTokenManager({ authPath: file, fetchImpl: fetchImpl as any });

    await expect(manager.getOrRefreshAccessToken()).resolves.toBe('fresh');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token, persists the result, and keeps the old refresh token when none is returned', async () => {
    const file = tmpFile('grok-auth.json');
    saveGrokTokens({ access_token: 'stale', refresh_token: 'r1', expires_at: Date.now() + 1_000 }, file);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new', expires_in: 3600 }));

    const manager = new GrokTokenManager({ authPath: file, fetchImpl: fetchImpl as any });

    await expect(manager.getOrRefreshAccessToken()).resolves.toBe('new');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GROK_TOKEN_ENDPOINT);
    expect(new URLSearchParams(init.body).get('grant_type')).toBe('refresh_token');
    expect(readStoredGrokTokens(file)).toMatchObject({ access_token: 'new', refresh_token: 'r1' });
  });

  it('spends the single-use refresh token once when callers race', async () => {
    const file = tmpFile('grok-auth.json');
    saveGrokTokens({ access_token: 'stale', refresh_token: 'r1', expires_at: Date.now() }, file);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new', expires_in: 3600 }));

    const manager = new GrokTokenManager({ authPath: file, fetchImpl: fetchImpl as any });
    const results = await Promise.all([manager.getOrRefreshAccessToken(), manager.getOrRefreshAccessToken()]);

    expect(results).toEqual(['new', 'new']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the grok CLI credential when term2 has none of its own', async () => {
    const cliFile = tmpFile('auth.json');
    fs.writeFileSync(cliFile, JSON.stringify({ entry: { key: 'from-cli' } }));

    const manager = new GrokTokenManager({
      authPath: tmpFile('grok-auth.json'),
      cliAuthPathResolver: () => cliFile,
    });

    await expect(manager.getOrRefreshAccessToken()).resolves.toBe('from-cli');
  });

  it('tells the user how to log in when no credential exists anywhere', async () => {
    const manager = new GrokTokenManager({ authPath: tmpFile('grok-auth.json'), cliAuthPathResolver: () => null });

    await expect(manager.getOrRefreshAccessToken()).rejects.toThrow(/--grok-login/);
  });

  it('surfaces a failed refresh instead of returning the expired token', async () => {
    const file = tmpFile('grok-auth.json');
    saveGrokTokens({ access_token: 'stale', refresh_token: 'r1', expires_at: Date.now() }, file);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));

    const manager = new GrokTokenManager({ authPath: file, fetchImpl: fetchImpl as any });

    await expect(manager.getOrRefreshAccessToken()).rejects.toThrow(/401/);
  });
});

describe('loginToGrok', () => {
  it('completes the PKCE flow and stores the exchanged tokens', async () => {
    const file = tmpFile('grok-auth.json');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'issued', refresh_token: 'r', expires_in: 3600 }));

    let authorizeUrl = '';
    const login = loginToGrok({
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
    const callback = new URL(GROK_REDIRECT_URI);
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', requested.searchParams.get('state')!);
    await fetch(callback);

    await expect(login).resolves.toMatchObject({ access_token: 'issued' });

    expect(requested.searchParams.get('code_challenge_method')).toBe('S256');
    expect(requested.searchParams.get('redirect_uri')).toBe(GROK_REDIRECT_URI);

    const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    // The verifier must match the challenge that opened the browser.
    const verifier = body.get('code_verifier')!;
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(requested.searchParams.get('code_challenge')).toBe(expected);

    expect(readStoredGrokTokens(file)).toMatchObject({ access_token: 'issued', refresh_token: 'r' });
  });

  it('rejects a callback whose state does not match the authorization request', async () => {
    const fetchImpl = vi.fn();
    let authorizeUrl = '';
    // Capture the rejection up front: it settles while we drive the callback,
    // which would otherwise surface as an unhandled rejection.
    const login = loginToGrok({
      authPath: tmpFile('grok-auth.json'),
      fetchImpl: fetchImpl as any,
      openBrowser: () => {},
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    const settled = login.then(
      () => ({ ok: true }),
      (error: Error) => ({ ok: false, error }),
    );

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    const callback = new URL(GROK_REDIRECT_URI);
    callback.searchParams.set('code', 'attacker-code');
    callback.searchParams.set('state', 'not-our-state');
    await fetch(callback);

    const result = (await settled) as { ok: boolean; error?: Error };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/state mismatch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
