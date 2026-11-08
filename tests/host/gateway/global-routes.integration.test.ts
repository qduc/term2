import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DirectWorkspaceAuthority } from '../../../src/app/host-config-workspace.js';
import { createDirectServerHost, createServerAuthentication } from '../../../src/host/server.js';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import { MemoryReplayLedger } from '../../../src/host/server-replay-ledger.js';
import type { AssertionPurpose, ServerConfiguration, SettingsProjection } from '../../../src/host/server-contracts.js';
import type { DirectHost } from '../../../src/host/in-process-direct-types.js';

it('routes workspace and local-owner configuration operations through their authorities over authenticated HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'server-global-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const socketPath = path.join(directory, 'gateway.sock');
  const ledger = new MemoryReplayLedger();
  const workspaces = new DirectWorkspaceAuthority({
    allowWrite: true,
    allowedRoots: [workspace],
    stateDirectory: directory,
  });
  const calls: unknown[] = [];
  const projection: SettingsProjection = {
    schemaVersion: 1,
    revision: 'revision-1',
    defaultsRevision: 'defaults-1',
    settings: {
      safeDefaults: {},
      credentials: {},
      providers: [],
      oauthAccounts: {},
      safety: {
        sandbox: 'enabled',
        approval: 'off',
        backgroundShell: 'disabled-by-gateway',
        workspaceAccess: 'read_write',
        network: 'denied',
      },
    },
  };
  // External credential/OAuth effects are replaced at the authority boundary.
  // Routing, validation, authentication, owner checks and workspace persistence are real.
  const configuration: ServerConfiguration = {
    read: () => projection,
    async write(revision, changes) {
      calls.push(['write', revision, changes]);
      return { ...projection, revision: 'revision-2' };
    },
    async setCredential(id, value) {
      calls.push(['credential_write', id, value]);
      return { status: 'saved', configured: true, source: 'local' };
    },
    async deleteCredential(id) {
      calls.push(['credential_delete', id]);
      return { status: 'deleted', configured: false };
    },
    async oauthLogin(provider) {
      calls.push(['oauth_login', provider]);
      return { status: 'not_completed' };
    },
    async oauthSelect(provider, account) {
      calls.push(['oauth_select', provider, account]);
      return { ok: true, isSelected: true, isInUse: false };
    },
    async oauthDelete(provider, account) {
      calls.push(['oauth_delete', provider, account]);
      return { ok: true };
    },
  };
  const host = new Proxy(
    {},
    {
      get() {
        throw new Error('Global routes must not attach a native session');
      },
    },
  ) as DirectHost;
  const transport = createDirectServerHost(
    {
      host,
      workspaces,
      configuration,
      localOwnerUserId: 'owner',
      models: () => [{ provider: 'fixture', id: 'model-1' }],
    },
    {
      transport: { socketPath },
      authentication: createServerAuthentication({
        issuer: 'test-bff',
        audience: 'test-gateway',
        publicKeys: { test: keys.publicKey },
        replayLedger: ledger,
      }),
    },
  );
  const rpc = async (purpose: AssertionPurpose, method: string, suffix: string, body?: unknown, subject = 'owner') => {
    const assertion = createGatewayAssertion({
      privateKey: keys.privateKey,
      kid: 'test',
      issuer: 'test-bff',
      audience: 'test-gateway',
      subject,
      purpose,
    });
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          socketPath,
          method,
          path: `/private/agent/v1${suffix}`,
          headers: {
            'x-term2-assertion': assertion,
            ...(encoded === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
          },
        },
        (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (raw += chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(raw) }));
        },
      );
      request.on('error', reject);
      request.end(encoded);
    });
  };
  try {
    await transport.start();
    expect((await rpc('workspace_list', 'GET', '/workspaces')).body).toEqual({ workspaces: [], nextCursor: null });
    const validation = await rpc('workspace_candidate_validate', 'POST', '/workspace/candidates/validate', {
      absolutePath: workspace,
    });
    expect(validation.status).toBe(200);
    expect(validation.body.valid).toBe(true);
    const candidateId = validation.body.candidateId;
    const browse = await rpc('workspace_candidate_browse', 'POST', '/workspace/candidates/browse', { candidateId });
    expect(browse).toMatchObject({ status: 200, body: { candidateId, entries: [], truncated: false } });
    const selection = await rpc('workspace_candidate_select', 'POST', '/workspace/candidates/select', {
      candidateId,
      access: 'read',
    });
    expect(selection).toMatchObject({
      status: 200,
      body: { binding: { canonicalRoot: workspace, ownerUserId: 'owner', access: 'read' } },
    });
    const revalidated = await rpc('workspace_candidate_validate', 'POST', '/workspace/candidates/validate', {
      absolutePath: workspace,
    });
    const conflict = await rpc('workspace_candidate_select', 'POST', '/workspace/candidates/select', {
      candidateId: revalidated.body.candidateId,
      access: 'read_write',
    });
    expect(conflict).toMatchObject({
      status: 403,
      body: {
        error: {
          code: 'workspace_forbidden',
          retryable: false,
          details: { existingAccess: 'read', grantStorage: 'persisted' },
        },
      },
    });
    const grants = JSON.parse(await readFile(path.join(directory, 'direct-workspace-grants.json'), 'utf8'));
    expect(grants.grants).toHaveLength(1);
    expect(grants.grants[0].access).toBe('read');
    const listed = await rpc('workspace_list', 'POST', '/workspaces');
    expect(listed).toMatchObject({
      status: 200,
      body: { workspaces: [{ workspaceId: selection.body.workspaceId, access: 'read' }] },
    });
    expect((await rpc('workspace_list', 'GET', '/workspaces', undefined, 'other')).body.workspaces).toEqual([]);
    expect(await rpc('settings_read', 'GET', '/settings')).toEqual({ status: 200, body: projection });
    const changed = [{ key: 'agent.temperature', value: 0.2 }];
    expect(
      await rpc('settings_write', 'PUT', '/settings', { expectedRevision: 'revision-1', changes: changed }),
    ).toMatchObject({ status: 200, body: { committed: true, revision: 'revision-2' } });
    expect(await rpc('credential_write', 'POST', '/credentials/openrouter', { value: 'fixture-secret' })).toEqual({
      status: 200,
      body: { status: 'saved', configured: true, source: 'local' },
    });
    expect(await rpc('credential_delete', 'DELETE', '/credentials/openrouter')).toEqual({
      status: 200,
      body: { status: 'deleted', configured: false },
    });
    expect(await rpc('oauth_login', 'POST', '/oauth/codex/login', {})).toEqual({
      status: 200,
      body: { status: 'not_completed' },
    });
    expect(await rpc('oauth_select', 'POST', '/oauth/codex/select', { accountId: 'account-1' })).toEqual({
      status: 200,
      body: { ok: true, isSelected: true, isInUse: false },
    });
    expect(await rpc('oauth_delete', 'DELETE', '/oauth/codex/accounts/account-1')).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await rpc('model_list', 'GET', '/models')).toEqual({
      status: 200,
      body: { models: [{ provider: 'fixture', id: 'model-1' }] },
    });
    expect(calls).toEqual([
      ['write', 'revision-1', changed],
      ['credential_write', 'openrouter', 'fixture-secret'],
      ['credential_delete', 'openrouter'],
      ['oauth_login', 'codex'],
      ['oauth_select', 'codex', 'account-1'],
      ['oauth_delete', 'codex', 'account-1'],
    ]);
  } finally {
    await transport.stop();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
