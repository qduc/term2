import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexTokenManager } from '../../src/model/providers/codex.provider.js';
import { createCodexAccountStore, saveCodexTokens } from '../../src/model/providers/codex-auth.js';
import { GrokTokenManager, saveGrokTokens, removeGrokAccount } from '../../src/model/providers/grok-auth.js';
import {
  OAuthAccountRefreshCoordinator,
  createSessionAccountStore,
  recordSessionAccount,
} from '../../src/model/providers/oauth-session-account.js';
import { createProviderRegistry } from '../../src/model/provider.js';
import { createProviderRegistry as createSourceRegistry } from '../../src/model/providers/registry.js';
import { createApprovalModelClient } from '../../src/app/lib/approval-model.js';
import { SessionContextService } from '../../src/model/traffic-context.js';
import type { LoggingService } from '../../src/session/logging/logging-service.js';
import { createMockSettingsService } from '../helpers/settings-service.mock.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const accessToken = (account: string, expired: boolean) =>
  `e30.${Buffer.from(JSON.stringify({ sub: account, exp: expired ? 1 : 4_000_000_000 })).toString(
    'base64url',
  )}.fixture`;

it.each(['codex', 'grok'] as const)(
  'coordinates one-use %s refreshes across session managers and advisory, isolating accounts and recovering after failure',
  async (provider) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'oauth-refresh-'));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    const authPath = path.join(scratch, `${provider}-auth.json`);
    const uses = new Map<string, number>();
    const attempts: string[] = [];
    let failNext = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const body =
        provider === 'codex'
          ? (JSON.parse(text) as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(text));
      const refresh = body.refresh_token;
      attempts.push(refresh);
      if (failNext) {
        failNext = false;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const count = (uses.get(refresh) ?? 0) + 1;
      uses.set(refresh, count);
      if (count > 1) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'refresh token already consumed' }));
        return;
      }
      const account = refresh.endsWith('-b') ? 'account-b' : 'account-a';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: accessToken(account, false),
          refresh_token: `rotated-${refresh}`,
          expires_in: 3600,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const fetchImpl: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/token`, init);
    const saveExpired = (account: string, refresh: string) =>
      provider === 'codex'
        ? saveCodexTokens(
            { access_token: accessToken(account, true), account_id: account, refresh_token: refresh },
            authPath,
          )
        : saveGrokTokens(
            {
              access_token: accessToken(account, true),
              user_id: account,
              expires_at: Date.now() - 1000,
              refresh_token: refresh,
            },
            authPath,
          );
    const manager = (store: ReturnType<typeof createSessionAccountStore>) =>
      provider === 'codex'
        ? new CodexTokenManager({ authPath, tokenPathResolver: () => null, fetchImpl, sessionAccountStore: store })
        : new GrokTokenManager({ authPath, cliAuthPathResolver: () => null, fetchImpl, sessionAccountStore: store });

    saveExpired('account-a', 'initial-a');
    const refreshes = new OAuthAccountRefreshCoordinator();
    const firstSession = createSessionAccountStore(refreshes);
    const secondSession = createSessionAccountStore(refreshes);
    const firstManager = manager(firstSession);
    const siblingManager = manager(firstSession);
    const anotherSessionManager = manager(secondSession);
    const providers = createSourceRegistry();
    providers.registerProvider({
      id: 'refresh-advisory',
      label: 'Refresh advisory',
      fetchModels: async () => [],
      createStreamedModel(_model, deps) {
        const tokens = manager(deps.sessionAccountStore!);
        return {
          async *stream() {
            await tokens.getOrRefreshAccessToken();
            yield { type: 'completion', responseId: 'advisory', output: [], finishReason: 'stop' };
          },
        };
      },
    });
    const selection = {
      settings: createMockSettingsService(),
      logger: logger as unknown as LoggingService,
      providers,
      sessionContext: new SessionContextService(),
      sessionAccountStore: firstSession,
    };
    const advisory = createApprovalModelClient(
      createProviderRegistry(selection),
      selection,
      new AbortController().signal,
      { conversationKey: 'session' },
    );
    const results = await Promise.all([
      firstManager.getOrRefreshAccessToken(),
      siblingManager.getOrRefreshAccessToken(),
      anotherSessionManager.getOrRefreshAccessToken(),
      advisory.chat('Check approval', { provider: 'refresh-advisory', model: 'fixture' }),
    ]);
    expect(results.slice(0, 3)).toEqual(Array(3).fill(accessToken('account-a', false)));
    expect(attempts).toEqual(['initial-a']);

    // The same credential owner queues writes but never shares another account's result.
    saveExpired('account-a', 'distinct-a');
    saveExpired('account-b', 'distinct-b');
    recordSessionAccount(provider, 'account-a', firstSession);
    recordSessionAccount(provider, 'account-b', secondSession);
    const isolated = await Promise.all([
      manager(firstSession).getOrRefreshAccessToken(),
      manager(secondSession).getOrRefreshAccessToken(),
    ]);
    expect(isolated).toEqual([accessToken('account-a', false), accessToken('account-b', false)]);
    expect(attempts.slice(-2).sort()).toEqual(['distinct-a', 'distinct-b']);

    // A rejected request releases both manager and credential-owner reservations.
    saveExpired('account-a', 'retry-a');
    failNext = true;
    const retrying = manager(firstSession);
    const before = attempts.length;
    const failures = await Promise.allSettled([retrying.getOrRefreshAccessToken(), retrying.getOrRefreshAccessToken()]);
    expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(attempts.length - before).toBe(1);
    expect(await retrying.getOrRefreshAccessToken()).toBe(accessToken('account-a', false));
    expect(attempts.length - before).toBe(2);
  },
);

it.each(['codex', 'grok'] as const)(
  'keeps %s accounts live during another refresh, handles cancellation and timeout, and revalidates removed pins',
  async (provider) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'oauth-live-'));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    const authPath = path.join(scratch, `${provider}-auth.json`);
    const attempts: string[] = [];
    const observed = new Set<string>();
    const waiting = new Map<string, () => void>();
    const held = new Map<string, () => void>();
    const hold = new Set(['hold-a', 'queue-a', 'queue-b', 'timeout-a']);
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const body =
        provider === 'codex'
          ? (JSON.parse(text) as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(text));
      const refresh = body.refresh_token;
      attempts.push(refresh);
      if (observed.has(refresh)) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      observed.add(refresh);
      const account = refresh.endsWith('-b') ? 'account-b' : 'account-a';
      const success = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: accessToken(account, false),
            refresh_token: `rotated-${refresh}`,
            expires_in: 3600,
          }),
        );
      };
      if (hold.has(refresh)) held.set(refresh, success);
      else success();
      waiting.get(refresh)?.();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const fetchImpl: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/token`, init);
    const waitFor = (key: string) =>
      observed.has(key) ? Promise.resolve() : new Promise<void>((resolve) => waiting.set(key, resolve));
    const save = (account: string, refresh: string, expired = true) =>
      provider === 'codex'
        ? saveCodexTokens(
            { access_token: accessToken(account, expired), account_id: account, refresh_token: refresh },
            authPath,
          )
        : saveGrokTokens(
            {
              access_token: accessToken(account, expired),
              user_id: account,
              expires_at: expired ? 1 : 4_000_000_000_000,
              refresh_token: refresh,
            },
            authPath,
          );
    const refreshes = new OAuthAccountRefreshCoordinator();
    const first = createSessionAccountStore(refreshes),
      second = createSessionAccountStore(refreshes);
    const manager = (store: ReturnType<typeof createSessionAccountStore>, refreshTimeoutMs = 2000) =>
      provider === 'codex'
        ? new CodexTokenManager({
            authPath,
            tokenPathResolver: () => null,
            fetchImpl,
            sessionAccountStore: store,
            refreshTimeoutMs,
          })
        : new GrokTokenManager({
            authPath,
            cliAuthPathResolver: () => null,
            fetchImpl,
            sessionAccountStore: store,
            refreshTimeoutMs,
          });
    save('account-a', 'hold-a');
    save('account-b', 'valid-b', false);
    recordSessionAccount(provider, 'account-a', first);
    recordSessionAccount(provider, 'account-b', second);
    const controller = new AbortController();
    const active = manager(first);
    let finished = false;
    const cancelled = active.getOrRefreshAccessToken(controller.signal).then(
      (value) => {
        finished = true;
        return value;
      },
      (error) => {
        finished = true;
        return error;
      },
    );
    await waitFor('hold-a');
    expect(await manager(second).getOrRefreshAccessToken()).toBe(accessToken('account-b', false));
    expect(finished).toBe(false);
    save('account-b', 'fast-b');
    expect(await manager(second).getOrRefreshAccessToken()).toBe(accessToken('account-b', false));
    expect(finished).toBe(false);
    controller.abort(new DOMException('Cancelled waiter', 'AbortError'));
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const sibling = manager(first).getOrRefreshAccessToken();
    held.get('hold-a')!();
    expect(await sibling).toBe(accessToken('account-a', false));
    expect(await active.getOrRefreshAccessToken()).toBe(accessToken('account-a', false));
    expect(attempts.filter((key) => key === 'hold-a')).toHaveLength(1);

    // A queued A request whose pin disappears must reacquire B, where B's
    // already-admitted rotation protects its one-use token.
    save('account-a', 'queue-a');
    save('account-b', 'queue-b');
    recordSessionAccount(provider, 'account-a', first);
    recordSessionAccount(provider, 'account-b', second);
    const firstOwner = manager(first).getOrRefreshAccessToken();
    await waitFor('queue-a');
    const fallback = manager(first).getOrRefreshAccessToken();
    const secondOwner = manager(second).getOrRefreshAccessToken();
    await waitFor('queue-b');
    expect(
      provider === 'codex'
        ? createCodexAccountStore(authPath).remove('account-a')
        : removeGrokAccount('account-a', authPath),
    ).toBe(true);
    held.get('queue-a')!();
    await firstOwner;
    held.get('queue-b')!();
    expect(await secondOwner).toBe(accessToken('account-b', false));
    expect(await fallback).toBe(accessToken('account-b', false));
    expect(attempts.filter((key) => key === 'queue-b')).toHaveLength(1);

    save('account-a', 'timeout-a');
    recordSessionAccount(provider, 'account-a', first);
    const timed = manager(first, 40);
    await expect(timed.getOrRefreshAccessToken()).rejects.toMatchObject({ name: 'TimeoutError' });
    // Reauthentication supplies a new rotation chain after the timed-out request.
    save('account-a', 'retry-after-timeout-a');
    expect(await timed.getOrRefreshAccessToken()).toBe(accessToken('account-a', false));
  },
);
