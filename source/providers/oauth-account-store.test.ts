import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OAuthAccountStore } from './oauth-account-store.js';

type Tokens = { access_token: string; refresh_token?: string; email?: string; sub?: string };

function makeStore(seed?: unknown) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-accounts-')), 'auth.json');
  if (seed !== undefined) fs.writeFileSync(filePath, JSON.stringify(seed));
  const store = new OAuthAccountStore<Tokens>({
    filePath,
    identify: (tokens) => ({ id: tokens.sub ?? tokens.email ?? 'default', label: tokens.email ?? 'account' }),
    migrateLegacy: (body: any) => (body?.access_token ? (body as Tokens) : null),
  });
  return { store, filePath };
}

describe('OAuthAccountStore', () => {
  it('reports no credential for a missing or unreadable file', () => {
    const { store } = makeStore();
    expect(store.getActiveTokens()).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('keeps several accounts and switches which one is active', () => {
    const { store } = makeStore();
    store.upsert({ access_token: 'a1', sub: 'user-a', email: 'a@example.com' });
    store.upsert({ access_token: 'b1', sub: 'user-b', email: 'b@example.com' });

    // The most recent login is active.
    expect(store.getActiveTokens()?.access_token).toBe('b1');
    expect(store.list().map((account) => account.label)).toEqual(['a@example.com', 'b@example.com']);

    expect(store.setActive('user-a')).toBe(true);
    expect(store.getActiveTokens()?.access_token).toBe('a1');
    expect(store.setActive('nobody')).toBe(false);
  });

  it('replaces an account on re-login instead of adding a duplicate', () => {
    const { store } = makeStore();
    store.upsert({ access_token: 'old', sub: 'user-a', email: 'a@example.com' });
    store.upsert({ access_token: 'new', sub: 'user-a', email: 'renamed@example.com' });

    expect(store.list()).toHaveLength(1);
    expect(store.getActiveTokens()?.access_token).toBe('new');
    expect(store.list()[0].label).toBe('renamed@example.com');
  });

  it('refreshes the active account in place, leaving other accounts untouched', () => {
    // Each account owns its own rotation chain; refreshing one must not disturb
    // another's refresh token or steal the active slot.
    const { store } = makeStore();
    store.upsert({ access_token: 'a1', refresh_token: 'ra1', sub: 'user-a' });
    store.upsert({ access_token: 'b1', refresh_token: 'rb1', sub: 'user-b' });
    store.setActive('user-a');

    store.updateActiveTokens({ access_token: 'a2', refresh_token: 'ra2', sub: 'user-a' });

    expect(store.getActive()?.id).toBe('user-a');
    expect(store.getActiveTokens()).toMatchObject({ access_token: 'a2', refresh_token: 'ra2' });
    expect(store.list().find((account) => account.id === 'user-b')?.tokens).toMatchObject({
      access_token: 'b1',
      refresh_token: 'rb1',
    });
  });

  it('hands the active slot to a survivor when the active account is removed', () => {
    const { store } = makeStore();
    store.upsert({ access_token: 'a1', sub: 'user-a' });
    store.upsert({ access_token: 'b1', sub: 'user-b' });

    expect(store.remove('user-b')).toBe(true);
    expect(store.getActive()?.id).toBe('user-a');

    expect(store.remove('user-a')).toBe(true);
    expect(store.getActive()).toBeNull();
    expect(store.remove('user-a')).toBe(false);
  });

  it('migrates a pre-multi-account file instead of logging the user out', () => {
    const { store } = makeStore({ access_token: 'legacy', refresh_token: 'r', sub: 'user-a', email: 'a@example.com' });

    expect(store.getActiveTokens()).toMatchObject({ access_token: 'legacy', refresh_token: 'r' });
    expect(store.list()).toHaveLength(1);
    expect(store.getActive()?.label).toBe('a@example.com');
  });

  it('does not rewrite the file merely because a credential was read', () => {
    const { store, filePath } = makeStore({ access_token: 'legacy', sub: 'user-a' });
    const before = fs.readFileSync(filePath, 'utf8');

    store.getActiveTokens();

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('writes with owner-only permissions', () => {
    const { store, filePath } = makeStore();
    store.upsert({ access_token: 'a1', sub: 'user-a' });

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('recovers when the active pointer names an account that is gone', () => {
    const { store } = makeStore({
      version: 2,
      activeAccountId: 'deleted-by-hand',
      accounts: [{ id: 'user-a', label: 'a@example.com', tokens: { access_token: 'a1' }, addedAt: 'x' }],
    });

    expect(store.getActive()?.id).toBe('user-a');
  });
});
