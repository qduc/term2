import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayAssertion } from './assertion.js';
import { Term2Gateway } from './gateway.js';
import { validateGatewayManifest } from './workspace-admission.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import type { RuntimeFactory } from './runtime-factory.js';

const roots: string[] = [];
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const get = async (socketPath: string, token: string) =>
  await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(
      { socketPath, method: 'GET', path: '/private/agent/v1/models', headers: { 'x-term2-assertion': token } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
      },
    );
    request.once('error', reject);
    request.end();
  });

describe('gateway model_list route', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    unregisterProvider('launcher-test-provider');
  });

  it('returns only the redacted model DTO from the real settings authority', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'term2-model-list-'));
    roots.push(root);
    registerProvider({
      id: 'launcher-test-provider',
      label: 'Launcher test provider',
      fetchModels: async () => [{ id: 'safe-model', name: 'Safe model', default_reasoning_level: 'medium' }],
    });
    const settingsAuthority = {
      get: (key: string) => (key === 'agent.provider' ? 'launcher-test-provider' : 'launcher-model'),
      getDynamic: (key: string) => (key === 'agent.provider' ? 'launcher-test-provider' : undefined),
    } as any;
    const runtimeFactory = {
      usesRealProviderStack: true,
      settingsAuthority,
      modelCatalogLogger: { warn: () => {} },
      shutdown: async () => {},
    } as unknown as RuntimeFactory;
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = validateGatewayManifest({
      version: 1,
      grants: [
        {
          workspaceId: 'workspace-a',
          ownerUserId: 'user-a',
          label: 'workspace',
          kind: 'local',
          localRoot: root,
          access: 'read',
          enabled: true,
        },
      ],
    });
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
      workspaceBoundaryProbe: (canonicalRoot, access) => ({
        mountedRoot: canonicalRoot,
        writable: access === 'read_write',
      }),
      auditWriter: async () => {},
      tmpDir: path.join(root, 'tmp'),
    });
    await gateway.start();
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'model_list',
    });
    const result = await get(path.join(root, 'gateway.sock'), token);
    expect(result.status).toBe(200);
    expect(result.body.models).toContainEqual({
      provider: 'launcher-test-provider',
      id: 'safe-model',
      name: 'Safe model',
      default_reasoning_level: 'medium',
    });
    expect(JSON.stringify(result.body)).not.toContain('apiKey');
    await gateway.shutdown(100);
  });
});
