import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCodexTokens } from './codex-auth.js';
import { saveGrokTokens } from './grok-auth.js';
import { resetSessionAccounts } from './oauth-session-account.js';
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
  resetSessionAccounts();
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
    // The most recent login is the selected one.
    expect(accounts.find((a) => a.isSelected)?.label).toBe('personal@example.com');
    // Nothing is in use until a request resolves a credential.
    expect(accounts.some((a) => a.isInUse)).toBe(false);

    expect(setActiveOAuthAccount('codex', 'u1')).toBe(true);
    expect(listOAuthAccounts('codex').find((a) => a.isSelected)?.label).toBe('work@example.com');
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
    expect(remaining[0]).toMatchObject({ label: 'a@example.com', isSelected: true });
  });

  it('reports no accounts before any login', () => {
    expect(listOAuthAccounts('codex')).toEqual([]);
    expect(listOAuthAccounts('grok')).toEqual([]);
    expect(setActiveOAuthAccount('codex', 'nobody')).toBe(false);
  });
});

it('separates the account in use from the one selected for next session', async () => {
  const { GrokTokenManager } = await import('./grok-auth.js');
  saveGrokTokens({ access_token: 'a', user_id: 'u1', email: 'a@example.com' });
  saveGrokTokens({ access_token: 'b', user_id: 'u2', email: 'b@example.com' });

  const manager = new GrokTokenManager({ cliAuthPathResolver: () => null });
  await manager.getOrRefreshAccessToken();

  // The session pinned the selected account on its first request...
  expect(listOAuthAccounts('grok').find((a) => a.isInUse)?.label).toBe('b@example.com');

  // ...and selecting another does not move it.
  setActiveOAuthAccount('grok', 'u1');
  const after = listOAuthAccounts('grok');
  expect(after.find((a) => a.isInUse)?.label).toBe('b@example.com');
  expect(after.find((a) => a.isSelected)?.label).toBe('a@example.com');
  await expect(manager.getOrRefreshAccessToken()).resolves.toBe('b');
});
