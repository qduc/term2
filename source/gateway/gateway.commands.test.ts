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
import { validateGatewayManifest, WorkspaceAdmission } from './workspace-admission.js';
import { SettingsService } from '../services/settings/settings-service.js';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import { createMockStream } from '../services/test-helpers/mock-stream.js';
import type { GatewayAssertionClaims, ProviderBrokerCapability } from './contracts.js';

const tempRoots: string[] = [];
const makeTemp = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-commands-'));
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
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: text });
          }
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function createTestManifest(root: string) {
  const workspacePath = path.join(root, 'workspaces', 'a');
  mkdtempSync(path.join(tmpdir(), 'term2-ws-a-'));
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      grants: [
        {
          workspaceId: 'workspace-a',
          ownerUserId: 'user-a',
          label: 'Workspace A',
          kind: 'local',
          localRoot: root,
          access: 'read_write',
          enabled: true,
        },
      ],
    }),
  );
  return { manifestPath, workspacePath };
}

describe('Gateway commands RPC route', () => {
  afterEach(() => {
    while (tempRoots.length) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  function setupGateway(options?: { createAgentClient?: () => ConversationAgentClient; auditRecords?: unknown[] }) {
    const root = makeTemp();
    const { manifestPath } = createTestManifest(root);
    const boundaryProbe = (canonicalRoot: string, access: 'read' | 'read_write') => ({
      mountedRoot: canonicalRoot,
      writable: access === 'read_write',
    });
    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
    const auditRecords = options?.auditRecords ?? [];
    const runtimeFactory = new RuntimeFactory({
      tmpDir: path.join(root, 'runtime'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      sandboxAvailable: true,
      createAgentClient:
        options?.createAgentClient ??
        (() =>
          ({
            chat: async () => '',
            abort: () => {},
            setModel: () => {},
            addToolInterceptor: () => () => {},
            startStream: async () => {
              const stream = createMockStream([{ type: 'final', finalText: 'assistant reply' }]);
              stream.finalOutput = 'assistant reply';
              return stream;
            },
            continueRunStream: async () => createMockStream([]),
          } as ConversationAgentClient)),
      createSettings: (defaults, tmpDir) => {
        const settings = new SettingsService({
          settingsDir: path.join(tmpDir, 'settings'),
          disableFilePersistence: true,
          disableLogging: true,
          env: {},
          cli: {},
        });
        settings.set('agent.provider', defaults.providerId, { persist: false });
        settings.set('agent.model', 'gpt-4', { persist: false });
        settings.set('agent.contextCompaction.compactThresholdTokens', 10_000, { persist: false });
        return settings;
      },
    });
    const gateway = Term2Gateway.create({
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
      auditWriter: async (metadata) => {
        auditRecords.push(metadata);
      },
      tmpDir: path.join(root, 'tmp'),
      runtimeFactory,
      persistence,
    });
    const token = (purpose: GatewayAssertionClaims['purpose'], sessionId?: string, sub = 'user-a') =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: sub,
        purpose,
        workspaceId: 'workspace-a',
        ...(sessionId ? { sessionId } : {}),
      });

    return { root, gateway, persistence, token, auditRecords, socketPath: path.join(root, 'gateway.sock') };
  }

  it('rejects invalid command body shape with 400 validation_error', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      expect(created.status).toBe(201);
      const sessionId = (created.body as { session: { id: string } }).session.id;

      // Missing clientRequestId
      const missingClientReq = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(missingClientReq.status).toBe(400);
      expect((missingClientReq.body as any).error.code).toBe('validation_error');

      // Extra properties
      const extraProps = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-1', extra: 'arg' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(extraProps.status).toBe(400);
      expect((extraProps.body as any).error.code).toBe('validation_error');
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('enforces owner check: non-owner gets 404 not_found', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      const nonOwnerToken = token('command_invoke', sessionId, 'user-attacker');
      const response = await rpc(
        socketPath,
        nonOwnerToken,
        { commandId: 'compact', clientRequestId: 'req-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(response.status).toBe(404);
      expect((response.body as any).error.code).toBe('not_found');
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('enforces allowlist: rejects unlisted commands with 422 command_not_allowed', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      for (const forbidden of ['clear', 'auto-approve', 'sandbox', 'model', 'comp', 'retry', 'unknown']) {
        const response = await rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: forbidden, clientRequestId: `req-${forbidden}` },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );
        expect(response.status).toBe(422);
        expect((response.body as any).error.code).toBe('command_not_allowed');
      }
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('writes an audit record for command invocations', async () => {
    const auditRecords: any[] = [];
    const { gateway, token, socketPath } = setupGateway({ auditRecords });
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-audit-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );

      const commandAudit = auditRecords.find((r) => r.operation === 'command_invoke');
      expect(commandAudit).toBeDefined();
      expect(commandAudit.outcome).toBe('allowed');
      expect(commandAudit.sessionId).toBe(sessionId);
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('rejects with 409 session_busy when session is running', async () => {
    let unblockStream: (() => void) | undefined;
    const { gateway, token, socketPath } = setupGateway({
      createAgentClient: () =>
        ({
          chat: async () => '',
          abort: () => {},
          setModel: () => {},
          addToolInterceptor: () => () => {},
          startStream: async () => {
            await new Promise<void>((resolve) => {
              unblockStream = resolve;
            });
            const stream = createMockStream([{ type: 'final', finalText: 'done' }]);
            stream.finalOutput = 'done';
            return stream;
          },
          continueRunStream: async () => createMockStream([]),
        } as ConversationAgentClient),
    });
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      // Submit a turn that blocks in startStream
      const submitPromise = rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'running turn', clientRequestId: 'turn-msg' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect((await submitPromise).status).toBe(202);

      // Now session is running; command must return 409 session_busy
      const busyCommand = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-busy' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(busyCommand.status).toBe(409);
      expect((busyCommand.body as any).error.code).toBe('session_busy');

      unblockStream?.();
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('handles compact command and idempotency replay', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      const first = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-compact-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        commandId: 'compact',
        outcome: expect.stringMatching(/completed|nothing_to_retry/),
      });

      // Replay same clientRequestId and body -> 200 with replayed: true
      const replayed = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-compact-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(replayed.status).toBe(200);
      expect((replayed.body as any).replayed).toBe(true);

      // Replay same clientRequestId with different body -> 409 conflict
      const conflict = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-turn', clientRequestId: 'req-compact-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(conflict.status).toBe(409);
      expect((conflict.body as any).error.code).toBe('idempotency_conflict');
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('handles retry-tool when nothing to retry', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      const response = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-tool', clientRequestId: 'req-tool-empty' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commandId: 'retry-tool',
        outcome: 'nothing_to_retry',
      });
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('handles retry-turn when nothing to retry on empty session', async () => {
    const { gateway, token, socketPath } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      const response = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-turn', clientRequestId: 'req-turn-empty' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commandId: 'retry-turn',
        outcome: 'nothing_to_retry',
      });
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('starts a turn on retry-turn and records assistant_started … turn_completed in journal', async () => {
    const { gateway, token, socketPath, persistence } = setupGateway();
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      // Submit first turn so session has history
      const submitted = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'initial question', clientRequestId: 'msg-1' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);

      // Wait for turn to settle
      const sessionPath = persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!;
      const eventPath = path.join(sessionPath, 'events.jsonl');
      await expect
        .poll(() => {
          if (!readFileSync(eventPath, 'utf8')) return false;
          const events = readFileSync(eventPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { type: string }).type);
          return events.includes('turn_completed');
        })
        .toBe(true);

      // Now invoke retry-turn
      const retryResult = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-turn', clientRequestId: 'retry-req-1' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(retryResult.status).toBe(200);
      expect(retryResult.body).toMatchObject({
        commandId: 'retry-turn',
        outcome: 'completed',
        turnId: expect.any(String),
      });
      const retryTurnId = (retryResult.body as any).turnId;

      // Check event journal for the retried turn sequence
      await expect
        .poll(() => {
          const events = readFileSync(eventPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type: string; payload: { turnId?: string } });
          const retryEvents = events.filter((e) => e.payload?.turnId === retryTurnId);
          return retryEvents.map((e) => e.type);
        })
        .toEqual(['assistant_started', 'turn_completed']);

      // Check admission index state
      const admission = persistence.index.admission('user-a', sessionId, 'retry-req-1');
      expect(admission?.state).toBe('terminal');
      expect(admission?.result).toBe('accepted');
    } finally {
      await gateway.shutdown(100);
    }
  });
});
