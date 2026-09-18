/**
 * The Milestone 2 integration: an OAuth-protected MCP server going from
 * `needs-auth`, through a login, to a `ready` connection whose tools are
 * callable — against the real fixtures, not mocks of the SDK.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpConnectionManager } from './mcp-connection-manager.js';
import { McpOAuthStore } from './mcp-oauth-store.js';
import { runMcpOAuthLogin } from './mcp-oauth-login.js';
import type { ResolvedMcpServerConfig } from './mcp-config.js';
import {
  startFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from './test-fixtures/fake-authorization-server.js';
import { startProtectedMcpServer, type ProtectedMcpServer } from './test-fixtures/protected-mcp-server.js';

let dir: string;
let authorizationServer: FakeAuthorizationServer;
let resourceServer: ProtectedMcpServer;
let store: McpOAuthStore;
let managers: McpConnectionManager[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-integration-'));
  store = new McpOAuthStore({ filePath: path.join(dir, 'mcp-oauth.json') });
  managers = [];
  authorizationServer = await startFakeAuthorizationServer();
  resourceServer = await startProtectedMcpServer({
    authorizationServerUrl: authorizationServer.issuer,
    verifyToken: async (token) =>
      authorizationServer.issuedAccessTokens.includes(token)
        ? { clientId: 'mcp-client', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600 }
        : null,
  });
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  await resourceServer.stop();
  await authorizationServer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const serverConfig = (overrides: Partial<ResolvedMcpServerConfig> = {}): ResolvedMcpServerConfig => ({
  name: 'protected',
  provenance: 'user',
  transport: 'streamable-http',
  url: resourceServer.url,
  ...overrides,
});

function manager(
  config: ResolvedMcpServerConfig,
  options: { interactive?: boolean; withStore?: boolean } = {},
): McpConnectionManager {
  const created = new McpConnectionManager({
    servers: [config],
    userConfigPath: '/home/user/.config/term2/mcp.json',
    workspaceRoot: dir,
    ...(options.withStore === false ? {} : { oauthStore: store }),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });
  managers.push(created);
  return created;
}

/**
 * Completes a login the way `/mcp-login` does, standing in for the browser by
 * fetching the authorization URL and following its redirect.
 */
async function login(config = serverConfig()): Promise<void> {
  await runMcpOAuthLogin({
    serverName: config.name,
    serverUrl: config.url ?? '',
    store,
    openBrowser: (url) => {
      // The real browser hits the loopback listener; fetching the URL makes the
      // fake authorization server issue exactly the same redirect.
      void fetch(url, { redirect: 'follow' }).catch(() => {});
    },
  });
}

const snapshotOf = (created: McpConnectionManager) => created.snapshot()[0];

describe('MCP OAuth connection integration', () => {
  it('rests in needs-auth naming /mcp-login instead of opening a browser', async () => {
    const created = manager(serverConfig());
    created.start();
    await created.whenSettled();

    const snapshot = snapshotOf(created);
    expect(snapshot.state).toBe('needs-auth');
    expect(snapshot.error).toContain('/mcp-login protected');
    expect(snapshot.tools).toEqual([]);
  });

  it('becomes ready with callable tools after a login and reconnect', async () => {
    const created = manager(serverConfig());
    created.start();
    await created.whenSettled();
    expect(snapshotOf(created).state).toBe('needs-auth');

    await login();
    await created.reconnect('protected');

    const snapshot = snapshotOf(created);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.tools.map((tool) => tool.name)).toContain('echo');

    const result = await created.callTool(
      'protected',
      'echo',
      { message: 'hi' },
      { signal: new AbortController().signal },
    );
    expect(result.isError).toBe(false);
  });

  it('connects straight to ready when a credential is already stored', async () => {
    await login();

    const created = manager(serverConfig());
    created.start();
    await created.whenSettled();

    expect(snapshotOf(created).state).toBe('ready');
    // No second browser round trip: the stored credential was presented directly.
    expect(authorizationServer.registeredClientIds).toHaveLength(1);
  });

  it('never presents a stored credential when no store is composed', async () => {
    await login();

    const created = manager(serverConfig(), { withStore: false });
    created.start();
    await created.whenSettled();

    expect(snapshotOf(created).state).toBe('needs-auth');
  });

  it('fails a non-interactive run with a reason instead of an untypeable command', async () => {
    const created = manager(serverConfig(), { interactive: false });
    created.start();
    await created.whenSettled();

    const snapshot = snapshotOf(created);
    expect(snapshot.state).toBe('failed');
    expect(snapshot.error).toContain('non-interactive');
    expect(snapshot.error).not.toContain('run /mcp-login');
  });

  it('refreshes silently in a non-interactive run once a token exists', async () => {
    await login();

    const created = manager(serverConfig(), { interactive: false });
    created.start();
    await created.whenSettled();

    expect(snapshotOf(created).state).toBe('ready');
  });
});

describe('project-config OAuth gate (decision D2)', () => {
  const projectServer = (enabled?: boolean): ResolvedMcpServerConfig =>
    serverConfig({
      name: 'repo-server',
      provenance: 'project',
      ...(enabled === undefined ? {} : { projectEnabledOverride: enabled }),
    });

  it('refuses a project server the user has not opted in, citing the config line', async () => {
    const created = manager(projectServer());
    created.start();
    await created.whenSettled();

    const snapshot = snapshotOf(created);
    expect(snapshot.state).toBe('failed');
    expect(snapshot.error).toContain('projectServers');
    expect(snapshot.error).toContain('repo-server');
    expect(created.oauthTarget('repo-server')).toBeUndefined();
  });

  it('does not present a stored credential to a project server that was never opted in', async () => {
    // A token obtained for this URL through a user entry must not leak to a
    // project entry naming the same URL.
    await login();

    const created = manager(projectServer());
    created.start();
    await created.whenSettled();

    expect(snapshotOf(created).state).toBe('failed');
    expect(snapshotOf(created).error).toContain('projectServers');
  });

  it('allows OAuth for a project server the user opted in', async () => {
    const created = manager(projectServer(true));
    created.start();
    await created.whenSettled();

    expect(snapshotOf(created).state).toBe('needs-auth');
    expect(created.oauthTarget('repo-server')).toMatchObject({ serverUrl: resourceServer.url });
  });
});

describe('runMcpOAuthLogin', () => {
  it('skips the browser when the stored refresh token still works', async () => {
    await login();

    let opened = 0;
    const result = await runMcpOAuthLogin({
      serverName: 'protected',
      serverUrl: resourceServer.url,
      store,
      openBrowser: () => {
        opened += 1;
      },
    });

    expect(result.interactive).toBe(false);
    expect(opened).toBe(0);
  });

  it('reports the authorization URL so a headless host can complete the login', async () => {
    const urls: string[] = [];
    await runMcpOAuthLogin({
      serverName: 'protected',
      serverUrl: resourceServer.url,
      store,
      onAuthorizationUrl: (url) => urls.push(url),
      openBrowser: (url) => {
        void fetch(url, { redirect: 'follow' }).catch(() => {});
      },
    });

    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).origin).toBe(authorizationServer.issuer);
  });
});

/**
 * Regression cover for defects found by probing real hosted servers, which the
 * fixture suite had missed.
 */
describe('real-server failure modes', () => {
  /** A server that refuses every request with a bare 401, like an SSE endpoint. */
  async function start401Server(): Promise<{ url: string; stop: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/sse`,
      stop: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it('routes an SSE transport 401 to needs-auth, not an opaque failure', async () => {
    // Observed against Asana and Atlassian: the legacy SSE transport reports the
    // refusal as `SseError: Non-200 status code (401)`, which used to land in
    // `failed` and left no way to log in.
    const refuser = await start401Server();
    try {
      const created = manager(serverConfig({ name: 'sse-server', transport: 'sse', url: refuser.url }));
      created.start();
      await created.whenSettled();

      const snapshot = snapshotOf(created);
      expect(snapshot.state).toBe('needs-auth');
      expect(snapshot.error).toContain('/mcp-login sse-server');
    } finally {
      await refuser.stop();
    }
  });

  it('presents a configured client id instead of attempting registration', async () => {
    // GitHub's authorization server advertises no registration_endpoint at all,
    // so a login can only start from a client id registered out of band.
    const config = serverConfig({ clientId: 'preregistered-client' });
    await runMcpOAuthLogin({
      serverName: config.name,
      serverUrl: config.url ?? '',
      store,
      clientId: 'preregistered-client',
      openBrowser: (url) => {
        void fetch(url, { redirect: 'follow' }).catch(() => {});
      },
    });

    // Nothing was dynamically registered, and the configured id was the one used.
    expect(authorizationServer.registeredClientIds).toHaveLength(0);
    expect(store.getTokens(config.url ?? '')).toBeDefined();
  });

  it('keeps a configured client id out of the credential store', async () => {
    const config = serverConfig({ clientId: 'preregistered-client' });
    await runMcpOAuthLogin({
      serverName: config.name,
      serverUrl: config.url ?? '',
      store,
      clientId: 'preregistered-client',
      openBrowser: (url) => {
        void fetch(url, { redirect: 'follow' }).catch(() => {});
      },
    });

    // Config owns the id; a persisted copy would go stale if the user changed it.
    const issuer = store.getTokens(config.url ?? '')?.issuer ?? '';
    expect(store.getClientInformation(config.url ?? '', issuer)).toBeUndefined();
  });
});
