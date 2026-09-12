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
import { ConversationService } from '../services/conversation/conversation-service.js';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import { createMockStream } from '../services/test-helpers/mock-stream.js';
import type { GatewayAssertionClaims, ProviderBrokerCapability } from './contracts.js';
import { hydrateTranscript } from './persistence/projection.js';
import { normalizedBodyHash } from './persistence/admission-persistence.js';
import type { AdmissionRecord } from './persistence/contracts.js';

const tempRoots: string[] = [];
const makeTemp = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-commands-'));
  tempRoots.push(root);
  return root;
};
const assistantMessageItem = (text: string) => ({
  role: 'assistant',
  type: 'message',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

/**
 * Production-shaped agent client: a completed turn commits its assistant
 * message to canonical history through the stream's run items. The default
 * mock returns no items, so a turn it "completes" leaves only the user message
 * in history — which is exactly the shape of a turn that committed nothing.
 */
const completedTurnClient = (): ConversationAgentClient =>
  ({
    chat: async () => '',
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => {
      const stream = createMockStream([{ type: 'final', finalText: 'assistant reply' }]);
      stream.finalOutput = 'assistant reply';
      stream.newItems = [assistantMessageItem('assistant reply')];
      stream.output = [assistantMessageItem('assistant reply')];
      return stream;
    },
    continueRunStream: async () => createMockStream([]),
  } as ConversationAgentClient);
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

  function setupGateway(options?: {
    createAgentClient?: () => ConversationAgentClient;
    auditRecords?: unknown[];
    /** Catalogued model for the session settings; the window gates compaction. */
    modelId?: string;
  }) {
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
        settings.set('agent.model', options?.modelId ?? 'gpt-4', { persist: false });
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

  it('refuses retry-turn when the last turn committed output', async () => {
    const { gateway, token, socketPath, persistence } = setupGateway({ createAgentClient: completedTurnClient });
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;

      const submitted = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'initial question', clientRequestId: 'msg-succeeded' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);

      const sessionPath = persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!;
      const eventPath = path.join(sessionPath, 'events.jsonl');
      await expect
        .poll(() => {
          const events = readFileSync(eventPath, 'utf8').split('\n').filter(Boolean);
          return events.some((line) => (JSON.parse(line) as { type: string }).type === 'turn_completed');
        })
        .toBe(true);

      // The turn committed output, so there is no failed turn to replay.
      const retryResult = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-turn', clientRequestId: 'retry-succeeded' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );

      expect(retryResult.status).toBe(200);
      expect(retryResult.body).toEqual({
        commandId: 'retry-turn',
        outcome: 'nothing_to_retry',
      });

      // The refusal settles the admission rather than admitting a turn whose
      // replay cannot start.
      const admission = persistence.index.admission('user-a', sessionId, 'retry-succeeded');
      expect(admission?.turnId).toBe('nothing_to_retry');
      expect(admission?.state).toBe('terminal');

      // Nothing was admitted: the journal still holds exactly one started turn.
      const events = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.filter((event) => event.type === 'assistant_started')).toHaveLength(1);
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('admits retry-turn when the last turn committed nothing, and records assistant_started … turn_completed in journal', async () => {
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

      // A turn that committed nothing leaves its user message as the last
      // canonical item, which is the only retryable shape.
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
        outcome: 'accepted',
        turnId: expect.any(String),
      });
      const retryTurnId = (retryResult.body as any).turnId;

      // Check event journal for the retried turn sequence (assistant_started directly, no empty user_message_accepted)
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

      // Check transcript does NOT contain user_message fact for retried turn
      const transcriptPath = path.join(sessionPath, 'term2.jsonl');
      const transcriptLines = readFileSync(transcriptPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const hasRetryTranscriptFact = transcriptLines.some(
        (l) => l.event?.type === 'user_message' && l.event?.message?.id === retryTurnId,
      );
      expect(hasRetryTranscriptFact).toBe(false);

      // Verify replay/restart: state.history has NO empty user message, only the initial question
      const restored = hydrateTranscript(sessionPath, sessionId);
      expect(restored).not.toBeNull();
      const userHistory = restored!.history.filter((m) => m.role === 'user');
      expect(userHistory).toHaveLength(1);
      expect(userHistory[0].content).toBe('initial question');
      expect(restored!.history.some((m) => m.role === 'user' && !m.content)).toBe(false);

      // Verify projection: no empty user turn is projected
      const read = await rpc(
        socketPath,
        token('session_read', sessionId),
        null,
        `/private/agent/v1/sessions/${sessionId}`,
      );
      expect(read.status).toBe(200);
      const projectedMessages = (
        read.body as { session: { transcript: { messages: Array<{ role: string; text: string }> } } }
      ).session.transcript.messages;
      const userProjected = projectedMessages.filter((m) => m.role === 'user');
      expect(userProjected).toHaveLength(1);
      expect(userProjected[0].text).toBe('initial question');
      expect(projectedMessages.some((m) => m.role === 'user' && !m.text)).toBe(false);

      // Check admission index state
      const admission = persistence.index.admission('user-a', sessionId, 'retry-req-1');
      expect(admission?.state).toBe('terminal');
      expect(admission?.result).toBe('accepted');
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('deduplicates concurrent compact requests with the same clientRequestId via pre-reservation', async () => {
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

      let gateResolve: () => void;
      const gate = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });
      let compactCallCount = 0;
      const origCompact = ConversationService.prototype.compactContext;
      ConversationService.prototype.compactContext = async function () {
        compactCallCount++;
        await gate;
        return origCompact.apply(this);
      };

      try {
        const req1 = rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'compact', clientRequestId: 'concurrent-compact-1' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );
        const req2 = rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'compact', clientRequestId: 'concurrent-compact-1' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );

        // Allow microtasks to execute so both requests reach #invokeCommand
        await new Promise((r) => setTimeout(r, 50));

        // compactContext should have only been invoked once while gated
        expect(compactCallCount).toBe(1);

        // Open the gate
        gateResolve!();

        const [res1, res2] = await Promise.all([req1, req2]);
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(compactCallCount).toBe(1);

        const bodies = [res1.body, res2.body] as any[];
        const replayed = bodies.filter((b) => b.replayed === true);
        const fresh = bodies.filter((b) => !b.replayed);
        expect(replayed).toHaveLength(1);
        expect(fresh).toHaveLength(1);
        expect(replayed[0].commandId).toBe('compact');
        expect(fresh[0].commandId).toBe('compact');
        expect(replayed[0].outcome).toBe(fresh[0].outcome);
      } finally {
        ConversationService.prototype.compactContext = origCompact;
      }
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('explicitly settles retry failures as terminal/failed rather than stranded accepted admission', async () => {
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
        { text: 'initial turn to populate history', clientRequestId: 'msg-seed' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);

      // Wait for first turn to complete
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

      // Force runtime start to fail during commit
      const origRetry = ConversationService.prototype.retryLastFailedTurn;
      ConversationService.prototype.retryLastFailedTurn = async function () {
        throw new Error('Simulated runtime start failure during retry');
      };

      try {
        const retryResult = await rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'retry-turn', clientRequestId: 'retry-forced-failure' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );
        expect(retryResult.status).toBeGreaterThanOrEqual(400);

        // Verify admission record is settled as terminal and failed, NOT stranded as accepted
        const admission = persistence.index.admission('user-a', sessionId, 'retry-forced-failure');
        expect(admission).toBeDefined();
        expect(admission?.state).toBe('terminal');
        expect(admission?.result).toBe('failed');

        // Verify journal ends with turn_failed rather than stranding assistant_started
        await expect
          .poll(() => {
            const events = readFileSync(eventPath, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { type: string; payload: { turnId?: string } });
            const retryEvents = events.filter((e) => e.payload?.turnId === admission?.turnId);
            return retryEvents.map((e) => e.type);
          })
          .toEqual(['assistant_started', 'turn_failed']);
      } finally {
        ConversationService.prototype.retryLastFailedTurn = origRetry;
      }
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('decodes persisted compact records safely on replay without casting into public outcome union', async () => {
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

      // Seed a compact:in_progress record representing an interrupted compaction after daemon restart
      const inProgressRecord: AdmissionRecord = {
        ownerUserId: 'user-a',
        sessionId,
        clientRequestId: 'req-interrupted',
        normalizedBodyHash: normalizedBodyHash({ commandId: 'compact', clientRequestId: 'req-interrupted' }),
        turnId: 'compact:in_progress',
        state: 'accepted',
        result: 'accepted',
        phase: 'committed',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      persistence.index.insertAdmission(inProgressRecord);

      // Replaying the interrupted compact command must return 409 compact_interrupted, retryable: false
      const interruptedRes = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-interrupted' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(interruptedRes.status).toBe(409);
      expect((interruptedRes.body as any).error).toMatchObject({
        code: 'compact_interrupted',
        retryable: false,
      });

      // Seed a compact:failed record
      const failedRecord: AdmissionRecord = {
        ownerUserId: 'user-a',
        sessionId,
        clientRequestId: 'req-failed',
        normalizedBodyHash: normalizedBodyHash({ commandId: 'compact', clientRequestId: 'req-failed' }),
        turnId: 'compact:failed',
        state: 'terminal',
        result: 'failed',
        phase: 'committed',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      persistence.index.insertAdmission(failedRecord);

      // Replaying the failed compact command must return 409 compact_failed, retryable: false
      const failedRes = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-failed' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(failedRes.status).toBe(409);
      expect((failedRes.body as any).error).toMatchObject({
        code: 'compact_failed',
        retryable: false,
      });

      // Seed a failed retry record
      const failedRetryRecord: AdmissionRecord = {
        ownerUserId: 'user-a',
        sessionId,
        clientRequestId: 'req-retry-failed',
        normalizedBodyHash: normalizedBodyHash({ commandId: 'retry-turn', clientRequestId: 'req-retry-failed' }),
        turnId: 'failed-retry-turn-id',
        state: 'terminal',
        result: 'failed',
        phase: 'committed',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      persistence.index.insertAdmission(failedRetryRecord);

      // Replaying a failed retry command must return 409 retry_failed, retryable: false
      const failedRetryRes = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'retry-turn', clientRequestId: 'req-retry-failed' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(failedRetryRes.status).toBe(409);
      expect((failedRetryRes.body as any).error).toMatchObject({
        code: 'retry_failed',
        retryable: false,
      });

      // Seed a completed compact record: compact:completed:1200:450
      const completedRecord: AdmissionRecord = {
        ownerUserId: 'user-a',
        sessionId,
        clientRequestId: 'req-completed',
        normalizedBodyHash: normalizedBodyHash({ commandId: 'compact', clientRequestId: 'req-completed' }),
        turnId: 'compact:completed:1200:450',
        state: 'terminal',
        result: 'accepted',
        phase: 'committed',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      persistence.index.insertAdmission(completedRecord);

      const completedRes = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'req-completed' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(completedRes.status).toBe(200);
      expect(completedRes.body).toMatchObject({
        commandId: 'compact',
        outcome: 'completed',
        tokensBefore: 1200,
        tokensAfter: 450,
        replayed: true,
      });
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('settles a retry that resolves null after admission instead of stranding assistant_started', async () => {
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

      // History whose last turn committed no output, so the retry is admitted.
      const submitted = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'question with no committed answer', clientRequestId: 'msg-null' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);

      const sessionPath = persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!;
      const eventPath = path.join(sessionPath, 'events.jsonl');
      await expect
        .poll(() => {
          const events = readFileSync(eventPath, 'utf8').split('\n').filter(Boolean);
          return events.some((line) => (JSON.parse(line) as { type: string }).type === 'turn_completed');
        })
        .toBe(true);

      const original = ConversationService.prototype.retryLastFailedTurn;
      ConversationService.prototype.retryLastFailedTurn = async function (
        options?: Parameters<typeof ConversationService.prototype.retryLastFailedTurn>[0],
      ) {
        options?.onAdmission?.();
        return null;
      };

      try {
        const retryResult = await rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'retry-turn', clientRequestId: 'retry-null' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );

        // The HTTP request is answered from the admission, and the failure is
        // reported through the journal rather than left as a stranded turn.
        expect(retryResult.status).toBe(200);
        expect(retryResult.body).toMatchObject({ commandId: 'retry-turn', outcome: 'accepted' });
        const retryTurnId = (retryResult.body as { turnId: string }).turnId;

        await expect
          .poll(() => {
            const events = readFileSync(eventPath, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { type: string; payload?: { turnId?: string } });
            return events.filter((event) => event.payload?.turnId === retryTurnId).map((event) => event.type);
          })
          .toEqual(['assistant_started', 'turn_failed']);

        const admission = persistence.index.admission('user-a', sessionId, 'retry-null');
        expect(admission?.state).toBe('terminal');
        expect(admission?.result).toBe('failed');
      } finally {
        ConversationService.prototype.retryLastFailedTurn = original;
      }
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('reports not_reduced when a compaction grows the context', async () => {
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

      const original = ConversationService.prototype.compactContext;
      ConversationService.prototype.compactContext = async () =>
        'Context compacted locally (60 → 360 estimated tokens).';

      try {
        const first = await rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'compact', clientRequestId: 'compact-grown' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );
        expect(first.status).toBe(200);
        expect(first.body).toEqual({
          commandId: 'compact',
          outcome: 'not_reduced',
          tokensBefore: 60,
          tokensAfter: 360,
        });

        // The recorded outcome decodes on replay instead of failing as an
        // unrecognized compaction state.
        const replayed = await rpc(
          socketPath,
          token('command_invoke', sessionId),
          { commandId: 'compact', clientRequestId: 'compact-grown' },
          `/private/agent/v1/sessions/${sessionId}/commands`,
        );
        expect(replayed.status).toBe(200);
        expect(replayed.body).toMatchObject({
          commandId: 'compact',
          outcome: 'not_reduced',
          tokensBefore: 60,
          tokensAfter: 360,
          replayed: true,
        });
      } finally {
        ConversationService.prototype.compactContext = original;
      }
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('journals compaction lifecycle events for a command issued outside a turn', async () => {
    const { gateway, token, socketPath, persistence } = setupGateway({ modelId: 'gpt-4-turbo' });
    await gateway.start();
    try {
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;
      const sessionPath = persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!;
      const eventPath = path.join(sessionPath, 'events.jsonl');

      // Local compaction needs at least three genuine user turns.
      for (const [index, clientRequestId] of ['msg-compact-1', 'msg-compact-2', 'msg-compact-3'].entries()) {
        const submitted = await rpc(
          socketPath,
          token('message_submit', sessionId),
          { text: `compaction question ${index}`, clientRequestId },
          `/private/agent/v1/sessions/${sessionId}/messages`,
        );
        expect(submitted.status).toBe(202);
        const expected = index + 1;
        await expect
          .poll(() => {
            const events = readFileSync(eventPath, 'utf8').split('\n').filter(Boolean);
            return events.filter((line) => (JSON.parse(line) as { type: string }).type === 'turn_completed').length;
          })
          .toBe(expected);
      }

      const compact = await rpc(
        socketPath,
        token('command_invoke', sessionId),
        { commandId: 'compact', clientRequestId: 'compact-events' },
        `/private/agent/v1/sessions/${sessionId}/commands`,
      );
      expect(compact.status).toBe(200);
      const compactBody = compact.body as { outcome: string; tokensBefore?: number; tokensAfter?: number };
      expect(compactBody.outcome).toBe('not_reduced');
      expect(compactBody.tokensAfter).toBeGreaterThanOrEqual(compactBody.tokensBefore!);

      const events = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; payload?: { turnId?: string } });
      const started = events.filter((event) => event.type === 'context_compaction_started');
      const completed = events.filter((event) => event.type === 'context_compaction_completed');
      expect(started).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(started[0]?.payload?.turnId).toEqual(expect.any(String));
      expect(started[0]?.payload?.turnId).toBe(completed[0]?.payload?.turnId);
    } finally {
      await gateway.shutdown(100);
    }
  });
});
