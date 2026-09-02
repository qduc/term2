import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayAssertion } from './assertion.js';
import { Term2Gateway } from './gateway.js';
import { RuntimeFactory } from './runtime-factory.js';
import { GatewayPersistenceCoordinator } from './persistence/coordinator.js';
import { createGatewayStorageLayout } from './persistence/storage.js';
import { createGatewayEventJournal } from './persistence/event-journal.js';
import { validateGatewayManifest } from './workspace-admission.js';
import { createMockStream } from '../services/test-helpers/mock-stream.js';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import type { GatewayAssertionClaims, ProviderBrokerCapability } from './contracts.js';

const tempRoots: string[] = [];
const makeTemp = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-'));
  tempRoots.push(root);
  return root;
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const broker: ProviderBrokerCapability = {
  capabilityId: 'cap-a',
  providerId: 'openai',
  modelId: 'operator-default',
  request: async () => ({ text: 'ok' }),
  async *stream() {
    yield { type: 'done' as const };
  },
};

function makeManifest(root: string, version = 1) {
  return validateGatewayManifest({
    version,
    grants: [
      {
        workspaceId: 'workspace-a',
        ownerUserId: 'user-a',
        label: 'A Workspace',
        kind: 'local',
        localRoot: root,
        access: 'read_write',
        enabled: true,
      },
      {
        workspaceId: 'workspace-b',
        ownerUserId: 'user-b',
        label: 'B Workspace',
        kind: 'local',
        localRoot: root,
        access: 'read',
        enabled: true,
      },
    ],
  });
}

const boundaryProbe = (canonicalRoot: string, access: 'read' | 'read_write') => ({
  mountedRoot: canonicalRoot,
  writable: access === 'read_write',
});

async function rpc(
  socketPath: string,
  token: string,
  body: unknown,
  pathName = '/',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: pathName,
        headers: {
          'x-term2-assertion': token,
          'content-type': 'application/json',
          ...extraHeaders,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('v1 compacted cursor over the gateway events route', () => {
  it('returns 410 cursor_compacted after a durable compactThrough on restart', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const layout = createGatewayStorageLayout(path.join(root, 'data'));
    const persistence = new GatewayPersistenceCoordinator(layout);
    const runtimeFactory = new RuntimeFactory({
      tmpDir: path.join(root, 'runtime'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      sandboxAvailable: true,
      createAgentClient: () =>
        ({
          chat: async () => '',
          abort: () => {},
          setModel: () => {},
          addToolInterceptor: () => () => {},
          startStream: async () => createMockStream([{ type: 'final', finalText: 'done' }]),
          continueRunStream: async () => createMockStream([]),
        } as ConversationAgentClient),
    });
    const createGateway = () =>
      Term2Gateway.create({
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
        workspaceBoundaryProbe: boundaryProbe,
        allowWrite: true,
        auditWriter: async () => undefined,
        tmpDir: path.join(root, 'tmp'),
        runtimeFactory,
        persistence,
      });
    const token = (purpose: GatewayAssertionClaims['purpose'], sessionId?: string) =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-a',
        purpose,
        workspaceId: 'workspace-a',
        ...(sessionId ? { sessionId } : {}),
      });
    let sessionId = '';
    const first = createGateway();
    try {
      await first.start();
      const created = await rpc(
        path.join(root, 'gateway.sock'),
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      expect(created.status).toBe(201);
      sessionId = (created.body as { session: { id: string } }).session.id;
    } finally {
      await first.shutdown(100);
    }
    const directory = layout.existingSessionPath('user-a', 'workspace-a', sessionId);
    expect(directory).toBeTruthy();
    const journal = createGatewayEventJournal({ sessionId, directory: directory! });
    expect(journal.highWater().lastPublishedSequence).toBeGreaterThanOrEqual(1);
    journal.compactThrough(1);
    journal.close();
    const restarted = createGateway();
    try {
      await restarted.start();
      const compacted = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: path.join(root, 'gateway.sock'),
            method: 'GET',
            path: `/private/agent/v1/sessions/${sessionId}/events?after=0`,
            headers: { 'x-term2-assertion': token('events_connect', sessionId) },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => {
              let body: unknown = text;
              try {
                body = text ? JSON.parse(text) : null;
              } catch {
                body = text;
              }
              resolve({ status: response.statusCode ?? 0, body });
            });
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(compacted.status).toBe(410);
      expect(compacted.body).toMatchObject({ error: { code: 'cursor_compacted' } });
      const details = (compacted.body as { error?: { details?: Record<string, unknown> } }).error?.details;
      expect(
        details?.reloadRequired === true || (compacted.body as { reloadRequired?: boolean }).reloadRequired === true,
      ).toBe(true);
    } finally {
      await restarted.shutdown(100);
      persistence.closeIndex();
      await runtimeFactory.shutdown();
    }
  });
});
