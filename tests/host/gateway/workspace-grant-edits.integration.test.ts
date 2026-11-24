import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DirectWorkspaceAuthority, serverWorkspaceAdministration } from '../../../src/app/host-config-workspace.js';
import { createDirectServerHost, createServerAuthentication } from '../../../src/host/server.js';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import { MemoryReplayLedger } from '../../../src/host/server-replay-ledger.js';
import type { AssertionPurpose } from '../../../src/host/server-contracts.js';
import type { DirectHost } from '../../../src/host/in-process-direct-types.js';

// Saved-folder edits over authenticated HTTP on a Unix socket, against the real grant
// authority and its grant file. Only the live-session host is replaced: these cases are
// about which edits the authority admits and what it persists. The child-process journey
// in serve.integration.test.ts covers live sessions.

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function startGateway(directory: string, workspaces: DirectWorkspaceAuthority) {
  const closed: string[] = [];
  const socketPath = path.join(directory, `gateway-${cleanup.length}.sock`);
  const ledger = new MemoryReplayLedger();
  const host = new Proxy(
    {},
    {
      get() {
        throw new Error('Grant edits must not attach a native session');
      },
    },
  ) as DirectHost;
  const transport = createDirectServerHost(
    {
      host,
      workspaces: serverWorkspaceAdministration(workspaces, async (root) => {
        closed.push(root);
        return 0;
      }),
      localOwnerUserId: 'owner',
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
  await transport.start();
  cleanup.push(async () => {
    await transport.stop();
    ledger.close();
  });
  const rpc = (
    purpose: AssertionPurpose,
    method: string,
    suffix: string,
    body?: unknown,
    ids: { workspaceId?: string } = {},
  ) => {
    const assertion = createGatewayAssertion({
      privateKey: keys.privateKey,
      kid: 'test',
      issuer: 'test-bff',
      audience: 'test-gateway',
      subject: 'owner',
      purpose,
      ...ids,
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
  const select = async (root: string, access: 'read' | 'read_write') => {
    const validated = await rpc('workspace_candidate_validate', 'POST', '/workspace/candidates/validate', {
      absolutePath: root,
    });
    const selected = await rpc('workspace_candidate_select', 'POST', '/workspace/candidates/select', {
      candidateId: validated.body.candidateId,
      access,
    });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    return selected.body.workspaceId as string;
  };
  const setAccess = (workspaceId: string, access: string) =>
    rpc('workspace_access_update', 'PUT', `/workspaces/${workspaceId}/access`, { access }, { workspaceId });
  const remove = (workspaceId: string) =>
    rpc('workspace_remove', 'DELETE', `/workspaces/${workspaceId}`, undefined, { workspaceId });
  const list = async () => (await rpc('workspace_list', 'GET', '/workspaces')).body.workspaces;
  return { rpc, select, setAccess, remove, list, closed };
}

async function scratch() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grant-edits-')));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const roots = { allowed: path.join(directory, 'allowed'), state: path.join(directory, 'state') };
  await mkdir(path.join(roots.allowed, 'one'), { recursive: true });
  await mkdir(path.join(roots.allowed, 'static'), { recursive: true });
  await mkdir(roots.state);
  const grantFile = () =>
    readFile(path.join(roots.state, 'direct-workspace-grants.json'), 'utf8').then((raw) => JSON.parse(raw).grants);
  return { directory, ...roots, grantFile };
}

it('refuses edits to startup grants and widening without write permission, and keeps a grant whose write failed', async () => {
  const { directory, allowed, state, grantFile } = await scratch();
  const staticRoot = path.join(allowed, 'static');
  const one = path.join(allowed, 'one');

  // Write-allowed server with one startup-supplied grant.
  const writable = await startGateway(
    directory,
    new DirectWorkspaceAuthority({
      allowWrite: true,
      stateDirectory: state,
      staticGrants: [
        { workspaceId: 'ws_static', ownerUserId: 'owner', label: 'static', root: staticRoot, access: 'read' },
      ],
    }),
  );
  const refusedStatic = { status: 409, body: { error: { code: 'workspace_grant_static', retryable: false } } };
  expect(await writable.setAccess('ws_static', 'read_write')).toMatchObject(refusedStatic);
  expect(await writable.remove('ws_static')).toMatchObject(refusedStatic);
  expect(await writable.list()).toEqual([{ workspaceId: 'ws_static', label: 'static', access: 'read' }]);
  expect(await writable.remove('ws_missing')).toMatchObject({
    status: 403,
    body: { error: { code: 'workspace_forbidden' } },
  });

  // Narrowing persists a new grant version and asks the host to close sessions in that root.
  const id = await writable.select(one, 'read_write');
  const [before] = await grantFile();
  const narrowed = await writable.setAccess(id, 'read');
  expect(narrowed).toEqual({
    status: 200,
    body: {
      workspace: { workspaceId: id, label: 'one', access: 'read' },
      grantVersion: before.grantVersion + 1,
      closedSessions: 0,
    },
  });
  expect(await grantFile()).toEqual([{ ...before, access: 'read', grantVersion: before.grantVersion + 1 }]);
  expect(writable.closed).toEqual([one]);
  // Setting the access it already has changes nothing, but still releases sessions.
  expect((await writable.setAccess(id, 'read')).body.grantVersion).toBe(before.grantVersion + 1);

  // A server started without write permission restores the same grant file and refuses widening.
  const readOnly = await startGateway(
    directory,
    new DirectWorkspaceAuthority({ allowWrite: false, stateDirectory: state }),
  );
  expect(await readOnly.setAccess(id, 'read_write')).toMatchObject({
    status: 403,
    body: { error: { code: 'workspace_write_not_allowed', retryable: false } },
  });
  expect(await grantFile()).toMatchObject([{ workspaceId: id, access: 'read' }]);
  expect(readOnly.closed).toEqual([]);

  // A grant file that cannot be written leaves the grant as it was, in memory and on disk.
  if (process.getuid?.() !== 0) {
    await chmod(state, 0o500);
    cleanup.push(() => chmod(state, 0o700));
    const unavailable = { status: 503, body: { error: { code: 'gateway_unavailable', retryable: true } } };
    expect(await writable.setAccess(id, 'read_write')).toMatchObject(unavailable);
    expect(await writable.remove(id)).toMatchObject(unavailable);
    expect(await writable.list()).toContainEqual({ workspaceId: id, label: 'one', access: 'read' });
    expect(await grantFile()).toMatchObject([
      { workspaceId: id, access: 'read', grantVersion: before.grantVersion + 1 },
    ]);
    expect(writable.closed).toEqual([one, one]);
    await chmod(state, 0o700);
  }

  // Removal deletes only the dynamic grant; the startup grant stays.
  expect(await writable.remove(id)).toEqual({
    status: 200,
    body: { workspaceId: id, removed: true, closedSessions: 0 },
  });
  expect(await grantFile()).toEqual([]);
  expect(await writable.list()).toEqual([{ workspaceId: 'ws_static', label: 'static', access: 'read' }]);
  expect(await writable.setAccess(id, 'read')).toMatchObject({ status: 403 });
});
