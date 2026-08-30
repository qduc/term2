import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayAssertion } from './assertion.js';
import { Term2Gateway } from './gateway.js';
import { validateGatewayManifest } from './workspace-admission.js';
import type { RuntimeFactory } from './runtime-factory.js';

const roots: string[] = [];
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const request = async (
  socketPath: string,
  method: string,
  pathname: string,
  purpose: string,
  body?: unknown,
  subject = 'user-a',
) => {
  const token = createGatewayAssertion({
    privateKey,
    kid: 'active',
    issuer: 'chatforge-bff',
    audience: 'term2-gateway',
    subject,
    purpose: purpose as any,
  });
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path: pathname,
        headers: { 'x-term2-assertion': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
};

describe('gateway settings/credential OAuth RPC', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('serves secret-free settings, write-only credentials, conflicts, and OAuth status', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'term2-settings-rpc-'));
    roots.push(root);
    vi.stubEnv('TERM2_CONFIG_DIR', path.join(root, 'term2-config'));
    // Isolate from host environment keys: resolveProviderCredentials reads
    // process.env directly, so a live OPENAI_API_KEY would make the openai
    // credential environment-sourced (non-writable) and fail the credential write.
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const values: Record<string, unknown> = {
      'agent.provider': 'openai',
      'agent.model': 'gpt-5',
      'agent.reasoningEffort': 'default',
      'agent.openai.apiKey': undefined,
      'shell.autoApproveMode': 'off',
      'sandbox.enabled': true,
    };
    const settings = {
      getDynamic: (key: string) => values[key],
      getSource: (key: string) => (key in values ? 'config' : 'default'),
      get: (key: string) => values[key],
      set: (_key: string, _value: unknown) => {},
      setDynamic: (_key: string, _value: unknown) => {},
      setPersistentDynamic: (key: string, value: unknown) => {
        values[key] = value;
        return { status: 'saved' as const };
      },
      setPersistentDynamicTransaction: (changes: readonly { key: string; value: unknown }[]) => {
        for (const change of changes) values[change.key] = change.value;
        return { status: 'saved' as const };
      },
      reset: (key?: string) => {
        if (key) delete values[key];
        return { status: 'saved' as const };
      },
    } as any;
    const runtimeFactory = {
      usesRealProviderStack: true,
      settingsAuthority: settings,
      shutdown: async () => {},
    } as unknown as RuntimeFactory;
    const manifest = validateGatewayManifest({ version: 1, grants: [] });
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const gateway = Term2Gateway.create({
      enabled: true,
      socketPath: path.join(root, 'gateway.sock'),
      manifestPath,
      manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      replayDbPath: path.join(root, 'replay.sqlite'),
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      publicKeys: { active: publicKey },
      runtimeFactory,
      workerSandboxAvailable: true,
      workspaceBoundaryProbe: () => false,
      oauthLogin: async () => {},
      localOwnerUserId: 'user-a',
      auditWriter: async () => {},
      tmpDir: path.join(root, 'tmp'),
    });
    await gateway.start();
    const socket = path.join(root, 'gateway.sock');
    const otherUser = await request(socket, 'GET', '/private/agent/v1/settings', 'settings_read', undefined, 'user-b');
    expect(otherUser.status).toBe(403);
    expect(otherUser.body.error.code).toBe('settings_forbidden');
    const read = await request(socket, 'GET', '/private/agent/v1/settings', 'settings_read');
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toMatch(/apiKey|credentialPath|environmentKey/);
    const revision = read.body.revision;
    const forbiddenWrite = await request(socket, 'PUT', '/private/agent/v1/settings', 'settings_write', {
      expectedRevision: revision,
      changes: [{ key: 'agent.model', value: 'gpt-5.1' }],
    });
    expect(forbiddenWrite.status).toBe(403);
    expect(forbiddenWrite.body.error.code).toBe('settings_forbidden');
    const write = await request(socket, 'PUT', '/private/agent/v1/settings', 'settings_write', {
      expectedRevision: revision,
      changes: [{ key: 'logging.logLevel', value: 'debug' }],
    });
    expect(write.status).toBe(200);
    const stale = await request(socket, 'PUT', '/private/agent/v1/settings', 'settings_write', {
      expectedRevision: revision,
      changes: [{ key: 'agent.model', value: 'stale' }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('settings_conflict');
    const credential = await request(socket, 'POST', '/private/agent/v1/credentials/openai', 'credential_write', {
      value: 'super-secret',
    });
    expect(credential).toEqual({ status: 200, body: { status: 'saved', configured: true, source: 'setting' } });
    expect(JSON.stringify(credential.body)).not.toContain('super-secret');
    const oauth = await request(socket, 'POST', '/private/agent/v1/oauth/codex/login', 'oauth_login', null);
    expect(oauth).toEqual({ status: 200, body: { status: 'completed', configured: false } });
    const select = await request(socket, 'POST', '/private/agent/v1/oauth/codex/select', 'oauth_select', {
      accountId: 'missing',
    });
    expect(select.status).toBe(200);
    expect(select.body).toEqual({ ok: false, isSelected: false, isInUse: false });
    await gateway.shutdown(100);

    const failClosedGateway = Term2Gateway.create({
      enabled: true,
      socketPath: path.join(root, 'gateway-no-owner.sock'),
      manifestPath,
      manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      replayDbPath: path.join(root, 'replay-no-owner.sqlite'),
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      publicKeys: { active: publicKey },
      runtimeFactory,
      workerSandboxAvailable: true,
      workspaceBoundaryProbe: () => false,
      oauthLogin: async () => {},
      auditWriter: async () => {},
      tmpDir: path.join(root, 'tmp-no-owner'),
    });
    await failClosedGateway.start();
    const missingOwner = await request(
      path.join(root, 'gateway-no-owner.sock'),
      'GET',
      '/private/agent/v1/settings',
      'settings_read',
    );
    expect(missingOwner.status).toBe(403);
    expect(missingOwner.body.error.code).toBe('settings_forbidden');
    await failClosedGateway.shutdown(100);
  });
});
