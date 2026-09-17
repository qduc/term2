import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';
import { McpOAuthProvider } from './mcp-oauth-provider.js';
import { McpOAuthStore } from './mcp-oauth-store.js';
import {
  startFakeAuthorizationServer,
  type FakeAuthorizationServer,
} from './test-fixtures/fake-authorization-server.js';
import { startProtectedMcpServer, type ProtectedMcpServer } from './test-fixtures/protected-mcp-server.js';

const REDIRECT_URI = 'http://127.0.0.1:49152/callback';

let dir: string;
let authorizationServer: FakeAuthorizationServer;
let resourceServer: ProtectedMcpServer;
let store: McpOAuthStore;
let authorizations: URL[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-flow-'));
  store = new McpOAuthStore({ filePath: path.join(dir, 'mcp-oauth.json') });
  authorizations = [];
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
  await resourceServer.stop();
  await authorizationServer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function provider(): McpOAuthProvider {
  return new McpOAuthProvider({
    store,
    serverUrl: resourceServer.url,
    redirectUrl: REDIRECT_URI,
    onAuthorizationRedirect: (url) => {
      authorizations.push(url);
    },
  });
}

/** Drives the redirect leg and returns the authorization code the browser would carry. */
async function beginAuthorization(client: McpOAuthProvider): Promise<string> {
  expect(await auth(client, { serverUrl: resourceServer.url })).toBe('REDIRECT');
  const redirected = await fetch(authorizations.at(-1)!, { redirect: 'manual' });
  expect(redirected.status).toBe(302);
  const location = new URL(redirected.headers.get('location') ?? '');
  expect(location.searchParams.get('state')).toBe(client.authorizationState);
  return location.searchParams.get('code') ?? '';
}

describe('OAuth-protected MCP server fixtures', () => {
  it('refuses an unauthenticated request and advertises its authorization server', async () => {
    const refused = await fetch(resourceServer.url);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain(resourceServer.resourceMetadataUrl);

    const metadata = (await (await fetch(resourceServer.resourceMetadataUrl)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(metadata.resource).toBe(resourceServer.url);
    expect(metadata.authorization_servers).toEqual([authorizationServer.issuer]);
  });
});

describe('MCP OAuth flow', () => {
  it('discoveres the authorization server, redirects, exchanges the code, and rotates the refresh token', async () => {
    const client = provider();

    // 1. No stored credential yet: the SDK discovers the AS and asks for a redirect.
    expect(await auth(client, { serverUrl: resourceServer.url })).toBe('REDIRECT');
    expect(authorizations).toHaveLength(1);
    const authorizationUrl = authorizations[0];
    expect(authorizationUrl.origin).toBe(authorizationServer.issuer);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorizationUrl.searchParams.get('state')).toBe(client.authorizationState);

    // 2. The browser authorizes; the AS redirects to the loopback listener.
    const redirected = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(redirected.status).toBe(302);
    const location = new URL(redirected.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe(client.authorizationState);
    const code = location.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    // 3. The callback leg redeems the code with the stored PKCE verifier.
    expect(await auth(client, { serverUrl: resourceServer.url, authorizationCode: code })).toBe('AUTHORIZED');
    expect(authorizationServer.registeredClientIds).toHaveLength(1);
    const first = client.tokens();
    expect(first?.access_token).toBe(authorizationServer.issuedAccessTokens[0]);
    expect(first?.refresh_token).toBeDefined();
    expect(store.getCodeVerifier(resourceServer.url)).toBeDefined();
    // The callback leg can only bind the issuer when discovery state survived the redirect.
    expect(store.getDiscoveryState(resourceServer.url)).toBeDefined();

    // 4. The resource server accepts the token the flow produced.
    const accepted = await fetch(resourceServer.url, {
      headers: { Authorization: `Bearer ${first?.access_token}` },
    });
    expect(accepted.status).not.toBe(401);

    // 5. A later connection refreshes instead of sending the user back to the browser.
    expect(await auth(client, { serverUrl: resourceServer.url })).toBe('AUTHORIZED');
    expect(authorizations).toHaveLength(1);
    expect(authorizationServer.refreshGrants).toEqual([first?.refresh_token]);
    expect(client.tokens()?.access_token).toBe(authorizationServer.issuedAccessTokens[1]);
    expect(client.tokens()?.refresh_token).not.toBe(first?.refresh_token);
  });

  it('refuses a token request whose PKCE verifier does not match the challenge', async () => {
    const client = provider();
    expect(await auth(client, { serverUrl: resourceServer.url })).toBe('REDIRECT');
    const redirected = await fetch(authorizations[0], { redirect: 'manual' });
    const code = new URL(redirected.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const response = await fetch(`${authorizationServer.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: authorizationServer.registeredClientIds.at(-1) ?? '',
        code_verifier: 'not-the-verifier',
      }).toString(),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
    expect(authorizationServer.refusedTokenRequests).toBe(1);
  });

  it('serves MCP tools to a client that presents the token it obtained', async () => {
    const oauth = provider();
    const code = await beginAuthorization(oauth);
    await auth(oauth, { serverUrl: resourceServer.url, authorizationCode: code });
    const accessToken = oauth.tokens()?.access_token ?? '';

    const mcp = new Client({ name: 'flow-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resourceServer.url), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await mcp.connect(transport);
    try {
      await expect(mcp.listTools()).resolves.toMatchObject({ tools: [expect.objectContaining({ name: 'echo' })] });
    } finally {
      await mcp.close();
    }
  });
});
