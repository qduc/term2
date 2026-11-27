/**
 * Client API v1.0 conformance suite (Step 10 & Step 13):
 * Crosses real Unix-socket HTTP+SSE transport, RS256 assertion verification, `SessionIndex`,
 * `DirectWorkspaceAuthority`, and validates wire payloads against `CLIENT_API_SCHEMAS` and the
 * committed `docs/plans/daemon/spec/client-api.schema.json`.
 */
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectWorkspaceAuthority, serverWorkspaceAdministration } from '../../src/app/host-config-workspace.js';
import { createDirectServerHost, createServerAuthentication } from '../../src/host/server.js';
import { createGatewayAssertion } from '../../src/host/server-assertion.js';
import { MemoryReplayLedger } from '../../src/host/server-replay-ledger.js';
import type { AssertionPurpose } from '../../src/host/server-contracts.js';
import type { DirectHost } from '../../src/host/in-process-direct-types.js';
import { createSessionIndex } from '../../src/host/daemon/session-index.js';
import { CLIENT_API_SCHEMAS } from '../../src/protocol/client-api/client-api-schema.js';
import { negotiateSingleProtocolVersion } from '../../src/protocol/client-api/version-negotiation.js';
import type { WireSnapshot } from '../../src/protocol/wire.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function makeSnapshot(overrides: Partial<WireSnapshot> & { sessionId: string }): WireSnapshot {
  return {
    protocolVersion: 1,
    sessionId: overrides.sessionId,
    seq: overrides.seq ?? 1,
    status: overrides.status ?? 'idle',
    model: overrides.model ?? { provider: 'openai', model: 'gpt-5' },
    activeTurnId: overrides.activeTurnId ?? null,
    messages: overrides.messages ?? [],
    tools: [],
    timeline: [],
    pendingInteractions: overrides.pendingInteractions ?? [],
    pendingBudgets: overrides.pendingBudgets ?? [],
    queue: [],
    queueState: 'idle',
    tasks: overrides.tasks ?? [],
    branches: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: 0,
    ...overrides,
  } as WireSnapshot;
}

type SseFrame = { readonly event: string; readonly data: Record<string, unknown> };

function openSseStream(
  socketPath: string,
  urlPath: string,
  headers: Record<string, string>,
): Promise<{
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly frames: SseFrame[];
  readonly nextFrame: (timeoutMs?: number) => Promise<SseFrame>;
  readonly close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', headers }, (res) => {
      const frames: SseFrame[] = [];
      const waiters: Array<(frame: SseFrame) => void> = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) {
            const frame: SseFrame = { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
            const waiter = waiters.shift();
            if (waiter) waiter(frame);
            else frames.push(frame);
          }
          idx = buffer.indexOf('\n\n');
        }
      });
      resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        frames,
        nextFrame(timeoutMs = 5_000) {
          const ready = frames.shift();
          if (ready) return Promise.resolve(ready);
          return new Promise<SseFrame>((resFrame, rejFrame) => {
            const timer = setTimeout(() => rejFrame(new Error('Timed out waiting for SSE frame')), timeoutMs);
            waiters.push((frame) => {
              clearTimeout(timer);
              resFrame(frame);
            });
          });
        },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpJson(
  socketPath: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ readonly statusCode: number; readonly headers: http.IncomingHttpHeaders; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Client API v1.0 conformance', () => {
  it('keeps committed client-api.schema.json in sync with client-api-schema.ts and version rules', async () => {
    const { buildClientApiJsonSchema } = await import('../../scripts/generate-client-api-schema.mjs');
    const committed = await readFile(
      path.resolve(process.cwd(), 'docs/plans/daemon/spec/client-api.schema.json'),
      'utf8',
    );
    expect(JSON.parse(committed)).toEqual(buildClientApiJsonSchema());
    expect(negotiateSingleProtocolVersion('1.0')).toEqual({ ok: true, version: '1.0' });
    expect(negotiateSingleProtocolVersion('1.2')).toEqual({ ok: true, version: '1.0' });
    expect(negotiateSingleProtocolVersion('2.0').ok).toBe(false);
  });

  it('enforces auth before version negotiation, serves hello/status, avoids N+1 connect on list, and streams live snapshot/upsert/remove', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'client-api-conf-'));
    const workspaceDir = path.join(directory, 'project');
    await mkdir(workspaceDir);
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const socketPath = path.join(directory, 'daemon-http.sock');
    const ledger = new MemoryReplayLedger();
    const grants = new DirectWorkspaceAuthority({
      allowWrite: true,
      stateDirectory: directory,
    });
    const validated = grants.validate({ userId: 'owner', via: 'assertion' }, workspaceDir);
    const selected = grants.select({ userId: 'owner', via: 'assertion' }, validated.candidateId, 'read_write');
    const workspaceId = selected.workspaceId;
    const workspaceRoot = selected.binding.canonicalRoot;

    const index = createSessionIndex({
      coalesceMs: 10,
      listStored: async () => ({
        sessions: [
          {
            id: 'conv_00000000-0000-4000-8000-000000000001',
            workspace: { root: workspaceRoot, access: 'read_write' },
            model: { provider: 'openai', model: 'gpt-5' },
            fullTitle: 'Pre-crash running session',
            createdAt: '2026-11-27T10:00:00.000Z',
            updatedAt: '2026-11-27T10:05:00.000Z',
            latestSequence: 4,
            status: 'running', // Must normalize to 'interrupted' on seed (client-api.md §5.2)
            binding: { client: 'owner', id: workspaceId },
          },
        ],
      }),
      resolveVisibility(principal, record) {
        if (principal.userId !== 'owner' || record.binding?.client !== 'owner') return { visible: false };
        try {
          const grant = grants.resolveGrant(principal, record.binding.id);
          return { visible: true, workspaceId: grant.workspaceId };
        } catch {
          return { visible: false };
        }
      },
    });
    await index.seed();

    const workspaces = serverWorkspaceAdministration(grants, async () => 0, {
      onRevoked: (root) => index.notifyWorkspaceRevoked(root),
      onGranted: (principal, root) => index.notifyWorkspaceGranted(principal, root),
    });

    // Enforce zero N+1 host.connect() calls during listSessions / sessions/events!
    const host = new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`SessionIndex list/stream must not call host.${String(prop)}()`);
        },
      },
    ) as DirectHost;

    const transport = createDirectServerHost(
      {
        host,
        workspaces,
        sessionIndex: index,
        daemonId: 'dmn_conformance01',
        daemonVersion: '2.2.0-test',
        localOwnerUserId: 'owner',
      },
      {
        transport: { socketPath },
        authentication: createServerAuthentication({
          issuer: 'test-bff',
          audience: 'test-gateway',
          publicKeys: new Map([['kid-1', keys.publicKey]]),
          replayLedger: ledger,
        }),
      },
    );
    await transport.start();
    cleanup.push(async () => {
      index.dispose();
      await transport.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const sign = (purpose: AssertionPurpose, subject = 'owner', extra?: { workspaceId?: string }) =>
      createGatewayAssertion({
        subject,
        purpose,
        ...(extra?.workspaceId ? { workspaceId: extra.workspaceId } : {}),
        issuer: 'test-bff',
        audience: 'test-gateway',
        kid: 'kid-1',
        privateKey: keys.privateKey,
      });

    // 1. Auth MUST run before version negotiation (401 before 400 protocol_incompatible).
    const unauth = await httpJson(socketPath, 'GET', '/private/agent/v1/hello', {
      'x-term2-client-api-version': '9.0',
    });
    expect(unauth.statusCode).toBe(401);

    // 2. Authenticated hello works for non-owner (omits pid); daemon/status is owner-only (403 for non-owner).
    const nonOwnerHello = await httpJson(socketPath, 'GET', '/private/agent/v1/hello', {
      'x-term2-assertion': sign('protocol_hello', 'viewer'),
      'x-term2-client-api-version': '1.2',
    });
    expect(nonOwnerHello.statusCode).toBe(200);
    expect(nonOwnerHello.headers['x-term2-client-api-version']).toBe('1.0');
    expect(nonOwnerHello.headers['x-term2-daemon-id']).toBe('dmn_conformance01');
    const welcomeParsed = CLIENT_API_SCHEMAS.protocolWelcomeResult.parse(nonOwnerHello.body);
    expect(welcomeParsed.pid).toBeUndefined();

    const nonOwnerStatus = await httpJson(socketPath, 'GET', '/private/agent/v1/daemon/status', {
      'x-term2-assertion': sign('daemon_status', 'viewer'),
    });
    expect(nonOwnerStatus.statusCode).toBe(403);

    const ownerStatus = await httpJson(socketPath, 'GET', '/private/agent/v1/daemon/status', {
      'x-term2-assertion': sign('daemon_status', 'owner'),
    });
    expect(ownerStatus.statusCode).toBe(200);
    CLIENT_API_SCHEMAS.daemonStatusResult.parse(ownerStatus.body);

    // 3. Incompatible major version after auth returns 400 protocol_incompatible.
    const badVersion = await httpJson(socketPath, 'GET', '/private/agent/v1/hello', {
      'x-term2-assertion': sign('protocol_hello', 'owner'),
      'x-term2-client-api-version': '2.0',
    });
    expect(badVersion.statusCode).toBe(400);
    expect((badVersion.body as { error: { code: string } }).error.code).toBe('protocol_incompatible');

    // 4. GET /private/agent/v1/sessions uses SessionIndex (zero host.connect calls) & normalizes pre-crash running -> interrupted.
    const listed = await httpJson(socketPath, 'GET', '/private/agent/v1/sessions?limit=20', {
      'x-term2-assertion': sign('session_list', 'owner'),
    });
    expect(listed.statusCode).toBe(200);
    const listParsed = CLIENT_API_SCHEMAS.sessionListResult.parse(listed.body);
    expect(listParsed.sessions).toHaveLength(1);
    expect(listParsed.sessions[0]!.status).toBe('interrupted');
    expect(listParsed.sessions[0]!.workspaceRoot).toBeUndefined();

    // 5. GET /private/agent/v1/sessions/events streams valid snapshot, live upserts, and remove on grant revocation.
    const stream = await openSseStream(socketPath, '/private/agent/v1/sessions/events', {
      'x-term2-assertion': sign('session_list_events', 'owner'),
      'x-term2-client-api-version': '1.0',
    });
    cleanup.push(async () => stream.close());
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['x-term2-client-api-version']).toBe('1.0');

    const snapshotFrame = await stream.nextFrame();
    expect(snapshotFrame.event).toBe('session.list.snapshot');
    const snap = CLIENT_API_SCHEMAS.sessionListSnapshotEvent.parse(snapshotFrame.data);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.status).toBe('interrupted');
    expect('protocolVersion' in snapshotFrame.data).toBe(false);

    // Emit live running -> awaiting_interaction (approval) transition on the seeded session.
    index.observeLifecycle({
      kind: 'snapshot',
      sessionId: 'conv_00000000-0000-4000-8000-000000000001',
      workspace: { root: workspaceRoot, access: 'read_write' },
      snapshot: makeSnapshot({
        sessionId: 'conv_00000000-0000-4000-8000-000000000001',
        seq: 5,
        status: 'running',
        messages: [{ id: 'm1', role: 'user', text: 'Pre-crash running session' } as WireSnapshot['messages'][number]],
      }),
      batch: { kind: 'accepted', seq: 5, occurredAt: '2026-11-27T11:00:00.000Z', ordinal: 1, events: [] },
    });
    const runningFrame = await stream.nextFrame();
    expect(runningFrame.event).toBe('session.list.upsert');
    const runningUpsert = CLIENT_API_SCHEMAS.sessionListUpsertEvent.parse(runningFrame.data);
    expect(runningUpsert.session.status).toBe('running');
    expect(runningUpsert.session.workspaceRoot).toBeUndefined();

    index.observeLifecycle({
      kind: 'snapshot',
      sessionId: 'conv_00000000-0000-4000-8000-000000000001',
      workspace: { root: workspaceRoot, access: 'read_write' },
      snapshot: makeSnapshot({
        sessionId: 'conv_00000000-0000-4000-8000-000000000001',
        seq: 6,
        status: 'awaiting_interaction',
        pendingInteractions: [{ requestId: 'req-1', kind: 'approval' } as WireSnapshot['pendingInteractions'][number]],
      }),
      batch: { kind: 'accepted', seq: 6, occurredAt: '2026-11-27T11:01:00.000Z', ordinal: 2, events: [] },
    });
    const approvalFrame = await stream.nextFrame();
    expect(approvalFrame.event).toBe('session.list.upsert');
    const approvalUpsert = CLIENT_API_SCHEMAS.sessionListUpsertEvent.parse(approvalFrame.data);
    expect(approvalUpsert.session.status).toBe('awaiting_interaction');
    expect(approvalUpsert.session.awaitingKind).toBe('approval');
    expect(approvalUpsert.session.pendingInteractionCount).toBe(1);

    // Revoke workspace grant -> must emit session.list.remove with reason workspace_revoked.
    const removed = await httpJson(socketPath, 'DELETE', `/private/agent/v1/workspaces/${workspaceId}`, {
      'x-term2-assertion': sign('workspace_remove', 'owner', { workspaceId }),
    });
    expect(removed.statusCode).toBe(200);
    const removeFrame = await stream.nextFrame();
    expect(removeFrame.event).toBe('session.list.remove');
    const removePayload = CLIENT_API_SCHEMAS.sessionListRemoveEvent.parse(removeFrame.data);
    expect(removePayload.sessionId).toBe('conv_00000000-0000-4000-8000-000000000001');
    expect(removePayload.reason).toBe('workspace_revoked');
  });
});
