import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { McpOAuthProvider } from './mcp-oauth-provider.js';
import { McpOAuthStore } from './mcp-oauth-store.js';

const SERVER = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test';
const OTHER_ISSUER = 'https://auth2.example.test';

let dir: string;
let store: McpOAuthStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-provider-'));
  store = new McpOAuthStore({ filePath: path.join(dir, 'mcp-oauth.json') });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function provider(options: Partial<ConstructorParameters<typeof McpOAuthProvider>[0]> = {}): McpOAuthProvider {
  return new McpOAuthProvider({
    store,
    serverUrl: SERVER,
    redirectUrl: 'http://127.0.0.1:49152/callback',
    onAuthorizationRedirect: () => {},
    ...options,
  });
}

const context = (issuer: string) => ({ issuer });

const tokens = (accessToken: string) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  refresh_token: `${accessToken}-refresh`,
});

describe('McpOAuthProvider', () => {
  it('satisfies the SDK client-provider interface', () => {
    const asInterface: OAuthClientProvider = provider();

    expect(typeof asInterface.redirectToAuthorization).toBe('function');
  });

  it('describes itself as a loopback public client', () => {
    const client = provider().clientMetadata;

    expect(client).toMatchObject({
      client_name: 'term2-mcp',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(client.redirect_uris).toEqual(['http://127.0.0.1:49152/callback']);
  });

  it('resolves the redirect URL when the port is chosen at runtime', () => {
    const client = provider({ redirectUrl: () => 'http://127.0.0.1:51234/callback' });

    expect(client.redirectUrl).toBe('http://127.0.0.1:51234/callback');
    expect(client.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:51234/callback']);
  });

  it('stores client information and tokens per authorization-server issuer', () => {
    const client = provider();
    client.saveClientInformation({ client_id: 'client-1', issuer: ISSUER }, context(ISSUER));
    client.saveClientInformation({ client_id: 'client-2', issuer: OTHER_ISSUER }, context(OTHER_ISSUER));
    client.saveTokens(tokens('a'), context(ISSUER));
    client.saveTokens(tokens('b'), context(OTHER_ISSUER));

    expect(client.clientInformation(context(ISSUER))).toMatchObject({ client_id: 'client-1' });
    expect(client.clientInformation(context(OTHER_ISSUER))).toMatchObject({ client_id: 'client-2' });
    expect(client.tokens(context(ISSUER))).toMatchObject({ access_token: 'a' });
    expect(client.tokens(context(OTHER_ISSUER))).toMatchObject({ access_token: 'b' });
  });

  it('returns the most recently saved tokens when the transport reads with no context', () => {
    const client = provider();
    client.saveTokens(tokens('older'), context(ISSUER));
    client.saveTokens(tokens('newer'), context(OTHER_ISSUER));

    expect(client.tokens()).toMatchObject({ access_token: 'newer' });
  });

  it('refuses to read or write credentials without knowing the issuer', () => {
    const client = provider();

    expect(() => client.clientInformation()).toThrow(/issuer/i);
    expect(() => client.saveClientInformation({ client_id: 'client-1' })).toThrow(/issuer/i);
    expect(() => client.saveTokens(tokens('a'))).toThrow(/issuer/i);
  });

  it('round-trips the PKCE code verifier through the store', () => {
    const client = provider();
    client.saveCodeVerifier('verifier-1');

    expect(client.codeVerifier()).toBe('verifier-1');
    expect(provider().codeVerifier()).toBe('verifier-1');
  });

  it('throws when the token exchange asks for a verifier that was never saved', () => {
    expect(() => provider().codeVerifier()).toThrow(/code verifier/i);
  });

  it('hands the authorization flow a state it can validate the callback against', () => {
    const client = provider({ createState: () => 'fixed-state' });

    expect(client.state()).toBe('fixed-state');
    expect(client.authorizationState).toBe('fixed-state');
  });

  it('generates a distinct state per call when none is injected', () => {
    const client = provider();

    expect(client.state()).not.toBe(provider().state());
  });

  it('delegates the authorization redirect instead of opening anything itself', async () => {
    const onAuthorizationRedirect = vi.fn();
    const client = provider({ onAuthorizationRedirect });

    await client.redirectToAuthorization(new URL('https://auth.example.test/authorize?x=1'));

    expect(onAuthorizationRedirect).toHaveBeenCalledWith(new URL('https://auth.example.test/authorize?x=1'));
  });

  it('round-trips discovery state so the callback leg can bind the issuer', () => {
    const client = provider();
    const discovery = {
      authorizationServerUrl: ISSUER,
      authorizationServerMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` },
    };
    client.saveDiscoveryState(discovery);

    expect(client.discoveryState()).toEqual(discovery);
    expect(provider().discoveryState()).toEqual(discovery);
  });

  it('invalidateCredentials clears only the requested scope', () => {
    const client = provider();
    const seed = () => {
      client.saveClientInformation({ client_id: 'client-1', issuer: ISSUER }, context(ISSUER));
      client.saveTokens(tokens('a'), context(ISSUER));
      client.saveCodeVerifier('verifier-1');
      client.saveDiscoveryState({ authorizationServerUrl: ISSUER });
    };

    seed();
    client.invalidateCredentials('tokens');
    expect(client.tokens(context(ISSUER))).toBeUndefined();
    expect(client.clientInformation(context(ISSUER))).toBeDefined();

    seed();
    client.invalidateCredentials('verifier');
    expect(() => client.codeVerifier()).toThrow();
    expect(client.discoveryState()).toBeDefined();

    seed();
    client.invalidateCredentials('discovery');
    expect(client.discoveryState()).toBeUndefined();

    seed();
    client.invalidateCredentials('all');
    expect(client.tokens(context(ISSUER))).toBeUndefined();
    expect(client.clientInformation(context(ISSUER))).toBeUndefined();
  });

  it('accepts a CIMD URL and rejects one the authorization server could not fetch', () => {
    expect(() => provider({ clientMetadataUrl: 'https://term2.example.test/client.json' })).not.toThrow();
    expect(provider({ clientMetadataUrl: 'https://term2.example.test/client.json' }).clientMetadataUrl).toBe(
      'https://term2.example.test/client.json',
    );

    expect(() => provider({ clientMetadataUrl: 'http://term2.example.test/client.json' })).toThrow();
    expect(() => provider({ clientMetadataUrl: 'https://term2.example.test/' })).toThrow();
  });
});
