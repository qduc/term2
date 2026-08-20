import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCodexTokens } from './codex-auth.js';
import { saveGrokTokens } from './grok-auth.js';
import {
  isOAuthAccountProvider,
  listOAuthAccounts,
  oauthLoginCommand,
  removeOAuthAccount,
  setActiveOAuthAccount,
} from './oauth-accounts.js';

/** A JWT whose payload carries the given claims; the signature is never checked. */
function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-accounts-'));
  vi.stubEnv('TERM2_CONFIG_DIR', configDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('oauth account facade', () => {
  it('recognises only the OAuth providers', () => {
    expect(isOAuthAccountProvider('codex')).toBe(true);
    expect(isOAuthAccountProvider('grok')).toBe(true);
    expect(isOAuthAccountProvider('openai')).toBe(false);
    expect(oauthLoginCommand('codex')).toBe('term2 --codex-login');
    expect(oauthLoginCommand('grok')).toBe('term2 --grok-login');
  });

  it('lists Codex accounts by email and marks the active one', () => {
    saveCodexTokens({ access_token: 'a', id_token: jwtWithClaims({ sub: 'u1', email: 'work@example.com' }) });
    saveCodexTokens({ access_token: 'b', id_token: jwtWithClaims({ sub: 'u2', email: 'personal@example.com' }) });

    const accounts = listOAuthAccounts('codex');
    expect(accounts.map((a) => a.label)).toEqual(['work@example.com', 'personal@example.com']);
    // The most recent login is active.
    expect(accounts.find((a) => a.isActive)?.label).toBe('personal@example.com');

    expect(setActiveOAuthAccount('codex', 'u1')).toBe(true);
    expect(listOAuthAccounts('codex').find((a) => a.isActive)?.label).toBe('work@example.com');
  });

  it("keeps each provider's accounts separate", () => {
    saveCodexTokens({ access_token: 'c', id_token: jwtWithClaims({ sub: 'u1', email: 'codex@example.com' }) });
    saveGrokTokens({ access_token: 'g', user_id: 'g1', email: 'grok@example.com' });

    expect(listOAuthAccounts('codex').map((a) => a.label)).toEqual(['codex@example.com']);
    expect(listOAuthAccounts('grok').map((a) => a.label)).toEqual(['grok@example.com']);
  });

  it('signs out of an account and promotes a survivor', () => {
    saveGrokTokens({ access_token: 'a', user_id: 'u1', email: 'a@example.com' });
    saveGrokTokens({ access_token: 'b', user_id: 'u2', email: 'b@example.com' });

    expect(removeOAuthAccount('grok', 'u2')).toBe(true);
    const remaining = listOAuthAccounts('grok');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ label: 'a@example.com', isActive: true });
  });

  it('reports no accounts before any login', () => {
    expect(listOAuthAccounts('codex')).toEqual([]);
    expect(listOAuthAccounts('grok')).toEqual([]);
    expect(setActiveOAuthAccount('codex', 'nobody')).toBe(false);
  });
});
