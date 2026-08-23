import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayAssertion } from './assertion.js';
import { DynamicWorkspaceRegistry } from './dynamic-workspace-registry.js';
import { Term2Gateway } from './gateway.js';
import { WorkspaceAdmission, validateGatewayManifest } from './workspace-admission.js';
import type { ProviderBrokerCapability } from './contracts.js';
import { createRealWorkspaceBoundaryProbe } from './workspace-boundary-probe.js';

const roots: string[] = [];
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const broker: ProviderBrokerCapability = {
  capabilityId: 'fixture-capability',
  providerId: 'fixture',
  modelId: 'fixture-model',
  request: async () => ({ text: 'ok' }),
  async *stream() {
    yield { type: 'done' as const };
  },
};

const call = async (socketPath: string, purpose: 'validate' | 'browse' | 'select', subject: string, body: unknown) => {
  const token = createGatewayAssertion({
    privateKey,
    kid: 'active',
    issuer: 'chatforge-bff',
    audience: 'term2-gateway',
    subject,
    purpose: `workspace_candidate_${purpose}` as any,
  });
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: `/private/agent/v1/workspace/candidates/${purpose}`,
        headers: { 'x-term2-assertion': token, 'content-type': 'application/json' },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
};

function gatewayConfig(
  root: string,
  manifest: ReturnType<typeof validateGatewayManifest>,
  extra: Record<string, unknown> = {},
) {
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    enabled: true,
    socketPath: path.join(root, 'gateway.sock'),
    manifestPath,
    manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    replayDbPath: path.join(root, 'replay.sqlite'),
    issuer: 'chatforge-bff',
    audience: 'term2-gateway',
    publicKeys: { active: publicKey },
    providerBroker: broker,
    providerProbe: { available: true, secretFree: true },
    workerSandboxAvailable: true,
    workspaceBoundaryProbe: createRealWorkspaceBoundaryProbe({ allowWrite: true }),
    allowWrite: true,
    auditWriter: async () => {},
    tmpDir: path.join(root, 'tmp'),
    ...extra,
  };
}

describe('gateway dynamic workspace RPC', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('pins validate, browse, and select DTOs without changing v1 routes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-rpc-'));
    roots.push(root);
    const manifest = validateGatewayManifest({
      version: 1,
      grants: [
        {
          workspaceId: 'workspace-a',
          ownerUserId: 'user-a',
          label: 'fixture',
          kind: 'local',
          localRoot: root,
          access: 'read_write',
          enabled: true,
        },
      ],
    });
    const gateway = Term2Gateway.create(gatewayConfig(root, manifest));
    await gateway.start();
    const socket = path.join(root, 'gateway.sock');
    const validated = await call(socket, 'validate', 'user-a', { absolutePath: root });
    expect(validated.status).toBe(200);
    expect(validated.body).toMatchObject({ valid: true, displayName: path.basename(root), checks: expect.any(Array) });
    expect(validated.body).not.toHaveProperty('canonicalRoot');
    const browsed = await call(socket, 'browse', 'user-a', { candidateId: validated.body.candidateId });
    expect(browsed.status).toBe(200);
    expect(browsed.body).toMatchObject({ candidateId: validated.body.candidateId, truncated: false });
    expect(browsed.body.entries).toEqual(expect.any(Array));
    const selected = await call(socket, 'select', 'user-a', {
      candidateId: validated.body.candidateId,
      access: 'read_write',
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      workspaceId: expect.stringMatching(/^ws_/),
      displayName: path.basename(root),
      binding: { ownerUserId: 'user-a', access: 'read_write', canonicalRoot: root },
    });
    await gateway.shutdown(100);
  });

  it('maps candidate ownership, expiry, and malformed requests to safe RPC errors', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-rpc-errors-'));
    roots.push(root);
    let now = 100;
    const manifest = validateGatewayManifest({ version: 1, grants: [] });
    const registry = new DynamicWorkspaceRegistry({
      admission: new WorkspaceAdmission(manifest, {
        allowWrite: true,
        boundaryProbe: createRealWorkspaceBoundaryProbe({ allowWrite: true }),
      }),
      allowedRoots: [root],
      now: () => now,
    });
    const gateway = Term2Gateway.create(gatewayConfig(root, manifest, { workspaceRegistry: registry }));
    await gateway.start();
    const socket = path.join(root, 'gateway.sock');
    const validated = await call(socket, 'validate', 'user-a', { absolutePath: root });
    const forbidden = await call(socket, 'browse', 'user-b', { candidateId: validated.body.candidateId });
    expect(forbidden).toEqual({
      status: 403,
      body: { error: { code: 'workspace_forbidden', message: 'workspace access denied' } },
    });
    now += 5 * 60_000 + 1;
    const expired = await call(socket, 'browse', 'user-a', { candidateId: validated.body.candidateId });
    expect(expired).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'workspace candidate not found' } },
    });
    const malformed = await call(socket, 'validate', 'user-a', { absolutePath: 1 });
    expect(malformed.status).toBe(400);
    await gateway.shutdown(100);
  });
});
