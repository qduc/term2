import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpOAuthStore, normalizeMcpServerUrl } from './mcp-oauth-store.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-store-'));
  storePath = path.join(dir, 'mcp-oauth.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tokens = (accessToken: string) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  refresh_token: `${accessToken}-r`,
});

function readFile(filePath = storePath): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** A filesystem seam that records every write-path call the store makes. */
function spiedFilesystem(
  calls: Array<{ op: string; args: unknown[] }>,
  failures: Record<string, Error> = {},
): typeof fs {
  const spy = Object.create(fs) as typeof fs;
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      const failure = failures[op];
      if (failure) throw failure;
      return (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[op](...args);
    };
  const target = spy as unknown as Record<string, unknown>;
  for (const op of ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'] as const) {
    target[op] = record(op);
  }
  return spy;
}

describe('normalizeMcpServerUrl', () => {
  it('treats a default port, a trailing slash, and a query or fragment as the same server', () => {
    expect(normalizeMcpServerUrl('https://mcp.example.test:443/mcp/')).toBe('https://mcp.example.test/mcp');
    expect(normalizeMcpServerUrl('https://mcp.example.test/mcp?token=x#y')).toBe('https://mcp.example.test/mcp');
    expect(normalizeMcpServerUrl('HTTPS://MCP.Example.Test/mcp')).toBe('https://mcp.example.test/mcp');
    expect(normalizeMcpServerUrl('http://mcp.example.test:80/mcp')).toBe('http://mcp.example.test/mcp');
  });

  it('keeps a non-default port and the path case', () => {
    expect(normalizeMcpServerUrl('https://mcp.example.test:8443/MCP')).toBe('https://mcp.example.test:8443/MCP');
  });

  it('ignores userinfo, which is not part of the server identity', () => {
    expect(normalizeMcpServerUrl('https://user:pw@mcp.example.test/mcp')).toBe('https://mcp.example.test/mcp');
    expect(normalizeMcpServerUrl('https://mcp.example.test/mcp')).toBe('https://mcp.example.test/mcp');
  });
});

describe('McpOAuthStore', () => {
  it('round-trips client information, tokens, verifier, and discovery state', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveClientInformation('https://mcp.example.test/mcp', 'https://auth.example.test', {
      client_id: 'client-1',
      issuer: 'https://auth.example.test',
    });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));
    store.saveCodeVerifier('https://mcp.example.test/mcp', 'verifier-1');
    store.saveDiscoveryState('https://mcp.example.test/mcp', {
      authorizationServerUrl: 'https://auth.example.test',
      resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
    });

    const reopened = new McpOAuthStore({ filePath: storePath });
    expect(reopened.getClientInformation('https://mcp.example.test/mcp', 'https://auth.example.test')).toMatchObject({
      client_id: 'client-1',
    });
    expect(reopened.getTokens('https://mcp.example.test/mcp', 'https://auth.example.test')).toMatchObject({
      access_token: 'at-1',
    });
    expect(reopened.getCodeVerifier('https://mcp.example.test/mcp')).toBe('verifier-1');
    expect(reopened.getDiscoveryState('https://mcp.example.test/mcp')).toMatchObject({
      authorizationServerUrl: 'https://auth.example.test',
    });
  });

  it('writes the credential file readable only by its owner', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));

    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it('finds a server saved under an equivalent URL spelling', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));

    expect(store.getTokens('https://mcp.example.test:443/mcp/', 'https://auth.example.test')).toMatchObject({
      access_token: 'at-1',
    });
    expect(Object.keys(readFile().servers)).toEqual(['https://mcp.example.test/mcp']);
  });

  it('never writes a password from a server URL into the credential file', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://api-user:secret-pass@mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));

    const written = fs.readFileSync(storePath, 'utf8');
    expect(written).not.toContain('secret-pass');
    expect(written).not.toContain('api-user');
    expect(Object.keys(readFile().servers)).toEqual(['https://mcp.example.test/mcp']);
    expect(store.getTokens('https://mcp.example.test/mcp')).toMatchObject({ access_token: 'at-1' });
  });

  it('never shares tokens between different server URLs', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('first'));
    store.saveTokens('https://other.example.test/mcp', 'https://auth.example.test', tokens('second'));

    expect(store.getTokens('https://mcp.example.test/mcp')).toMatchObject({ access_token: 'first' });
    expect(store.getTokens('https://other.example.test/mcp')).toMatchObject({ access_token: 'second' });
    expect(Object.keys(readFile().servers)).toHaveLength(2);
  });

  it('keys client information and tokens by authorization server issuer', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('a'));
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth2.example.test', tokens('b'));

    expect(store.getTokens('https://mcp.example.test/mcp', 'https://auth.example.test')).toMatchObject({
      access_token: 'a',
    });
    expect(store.getTokens('https://mcp.example.test/mcp', 'https://auth2.example.test')).toMatchObject({
      access_token: 'b',
    });
  });

  it('returns the most recently saved tokens when no issuer is given', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('older'));
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth2.example.test', tokens('newer'));

    expect(store.getTokens('https://mcp.example.test/mcp')).toMatchObject({ access_token: 'newer' });
  });

  it('returns an empty store for a corrupt file instead of throwing', () => {
    fs.writeFileSync(storePath, '{ not json');
    const store = new McpOAuthStore({ filePath: storePath });

    expect(store.read()).toEqual({ version: 1, servers: {} });
    expect(store.getTokens('https://mcp.example.test/mcp')).toBeUndefined();

    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));
    expect(new McpOAuthStore({ filePath: storePath }).getTokens('https://mcp.example.test/mcp')).toMatchObject({
      access_token: 'at-1',
    });
  });

  it('sweeps temporary files left by an interrupted write', () => {
    const stale = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    const legacy = `${storePath}.tmp`;
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(legacy, '{}');

    new McpOAuthStore({ filePath: storePath });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('replaces the file through a fsynced temporary file and a rename', () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const store = new McpOAuthStore({ filePath: storePath, filesystem: spiedFilesystem(calls) });

    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('at-1'));

    const opened = calls.find((call) => call.op === 'openSync');
    const tmpPath = opened?.args[0] as string;
    expect(tmpPath).not.toBe(storePath);
    expect(tmpPath).toMatch(/\.tmp$/);
    expect(opened?.args[1]).toBe('w');
    expect(opened?.args[2]).toBe(0o600);
    expect(calls.map((call) => call.op)).toEqual(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']);
    expect(calls.at(-1)?.args).toEqual([tmpPath, storePath]);
  });

  it('leaves the previous credentials and no temporary file when the rename fails', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('old'));

    const failing = spiedFilesystem([], { renameSync: new Error('rename exploded') });
    const writer = new McpOAuthStore({ filePath: storePath, filesystem: failing });

    expect(() => writer.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('new'))).toThrow(
      /rename exploded/,
    );
    expect(new McpOAuthStore({ filePath: storePath }).getTokens('https://mcp.example.test/mcp')).toMatchObject({
      access_token: 'old',
    });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('invalidateCredentials clears only the requested scope', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    const server = 'https://mcp.example.test/mcp';
    const seed = () => {
      store.saveClientInformation(server, 'https://auth.example.test', { client_id: 'client-1' });
      store.saveTokens(server, 'https://auth.example.test', tokens('at-1'));
      store.saveCodeVerifier(server, 'verifier-1');
      store.saveDiscoveryState(server, { authorizationServerUrl: 'https://auth.example.test' });
    };

    seed();
    store.invalidateCredentials(server, 'client');
    expect(store.getClientInformation(server, 'https://auth.example.test')).toBeUndefined();
    expect(store.getTokens(server)).toBeDefined();
    expect(store.getCodeVerifier(server)).toBe('verifier-1');

    seed();
    store.invalidateCredentials(server, 'tokens');
    expect(store.getTokens(server)).toBeUndefined();
    expect(store.getClientInformation(server, 'https://auth.example.test')).toBeDefined();

    seed();
    store.invalidateCredentials(server, 'verifier');
    expect(store.getCodeVerifier(server)).toBeUndefined();
    expect(store.getDiscoveryState(server)).toBeDefined();

    seed();
    store.invalidateCredentials(server, 'discovery');
    expect(store.getDiscoveryState(server)).toBeUndefined();
    expect(store.getTokens(server, 'https://auth.example.test')).toBeDefined();

    store.invalidateCredentials(server, 'all');
    expect(store.getTokens(server)).toBeUndefined();
    expect(store.getCodeVerifier(server)).toBeUndefined();
    expect(readFile().servers).toEqual({});
  });

  it('ignores entries for other servers when invalidating one', () => {
    const store = new McpOAuthStore({ filePath: storePath });
    store.saveTokens('https://mcp.example.test/mcp', 'https://auth.example.test', tokens('mine'));
    store.saveTokens('https://other.example.test/mcp', 'https://auth.example.test', tokens('theirs'));

    store.invalidateCredentials('https://mcp.example.test/mcp', 'all');

    expect(store.getTokens('https://other.example.test/mcp')).toMatchObject({ access_token: 'theirs' });
  });
});
