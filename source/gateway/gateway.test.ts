import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AssertionVerifier, createGatewayAssertion, GatewayAssertionError } from './assertion.js';
import {
  classifyInteractionResolution,
  assertGatewayStartup,
  GatewayStartupError,
  interactionDtoFromSnapshot,
  isInteractionResolveRequest,
  isPublicEventEnvelope,
  sessionConfigProjection,
  Term2Gateway,
} from './gateway.js';
import { RuntimeFactory } from './runtime-factory.js';
import { GatewayLifecycle } from './lifecycle.js';
import { MemoryReplayLedger, SqliteReplayLedger, type ReplayLedger } from './replay-ledger.js';
import { GatewayPersistenceCoordinator } from './persistence/coordinator.js';
import { createGatewayStorageLayout } from './persistence/storage.js';
import { createGatewayEventJournal } from './persistence/event-journal.js';
import { createSafeLogMetadata, GatewayLogError } from './safe-log.js';
import { executeShellCommand, GatewayShellEnvironmentError } from '../utils/shell/execute-shell.js';
import {
  assertExplicitSanitizedEnv,
  createSanitizedWorkerEnv,
  composeGatewaySession,
  WorkerBoundaryError,
} from './worker-boundary.js';
import { validateGatewayManifest, WorkspaceAdmission, WorkspaceAdmissionError } from './workspace-admission.js';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import { createAgentStream } from '../services/agent-stream.js';
import { createMockStream } from '../services/test-helpers/mock-stream.js';
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
const secondKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secondPrivateKey = secondKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const secondPublicKey = secondKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const claimsFor = (
  purpose: GatewayAssertionClaims['purpose'] = 'session_create',
  extra: Partial<GatewayAssertionClaims> = {},
) => ({
  iss: 'chatforge-bff',
  aud: 'term2-gateway',
  sub: 'user-a',
  purpose,
  iat: 1_000,
  nbf: 995,
  exp: 1_050,
  jti: crypto.randomUUID(),
  ver: 1 as const,
  ...extra,
});
const broker: ProviderBrokerCapability = {
  capabilityId: 'cap-a',
  providerId: 'openai',
  modelId: 'operator-default',
  request: async () => ({ text: 'ok' }),
  async *stream() {
    yield { type: 'done' as const };
  },
};

// Mirrors ChatForge's fail-closed transcript validator. Keep this list pinned
// so a gateway projection field drift is caught before interop smoke.
const TRANSCRIPT_KEYS = new Set([
  'messages',
  'items',
  'commands',
  'entries',
  'turns',
  'id',
  'messageId',
  'turnId',
  'role',
  'type',
  'content',
  'text',
  'delta',
  'toolName',
  'callId',
  'argumentsText',
  'display',
  'command',
  'target',
  'scope',
  'warning',
  'status',
  'outcome',
  'occurredAt',
  'createdAt',
  'updatedAt',
  'usage',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reason',
  'error',
  'version',
  'label',
  'description',
  'destructive',
  'choices',
  'displayPath',
  'displayParent',
  'sensitive',
  'metadata',
  'name',
  'value',
]);
const FORBIDDEN_TRANSCRIPT_KEYS = new Set([
  'ownerUserId',
  'localRoot',
  'canonicalRoot',
  'sshTargetId',
  'remoteRoot',
  'host',
  'username',
  'port',
  'agentProfileId',
  'identityFile',
  'identityFilePath',
  'privateKey',
  'keyMaterial',
  'SSH_AUTH_SOCK',
  'providerId',
  'providerResponseId',
  'rawInterruption',
  'stack',
  'stackTrace',
  'credential',
  'credentials',
  'path',
  'filePath',
  'cwd',
  'projectPath',
  'root',
  'sshHost',
  'sshPort',
]);

function assertFrozenTranscript(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) assertFrozenTranscript(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    expect(FORBIDDEN_TRANSCRIPT_KEYS.has(key)).toBe(false);
    expect(TRANSCRIPT_KEYS.has(key)).toBe(true);
    assertFrozenTranscript(child);
  }
}

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

function makeAdmission(root: string, allowWrite = true) {
  return new WorkspaceAdmission(makeManifest(root), { allowWrite, boundaryProbe });
}

function parkedStream(): { stream: ReturnType<typeof createAgentStream>; release: () => void; started: Promise<void> } {
  let release!: () => void;
  let resolveStarted!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const stream = createAgentStream({
    async *[Symbol.asyncIterator]() {
      resolveStarted();
      await parked;
      yield { type: 'final' as const, finalText: 'done' } as never;
    },
    completed: parked,
    history: [],
    newItems: [],
    output: [],
    lastResponseId: null,
  });
  return { stream, release, started };
}

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

function makeVerifier(ledger: ReplayLedger = new MemoryReplayLedger(), clock = () => 1_000) {
  return {
    verifier: new AssertionVerifier({
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      publicKeys: { old: publicKey, active: publicKey },
      replayLedger: ledger,
      clock,
    }),
    ledger,
  };
}

async function connectEvents(
  socketPath: string,
  token: string,
  pathName: string,
): Promise<{ status: number; close: () => void }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: 'GET',
        path: pathName,
        headers: { 'x-term2-assertion': token },
      },
      (response) => {
        response.on('error', () => undefined);
        resolve({ status: response.statusCode ?? 0, close: () => response.destroy() });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('gateway startup and assertion verifier', () => {
  it('projects the effective fail-closed tool policy and hashes it into the config revision', () => {
    const session = {
      sessionId: 'session-a',
      resources: {
        settings: {
          providerId: 'openai',
          modelId: 'gpt-5',
          reasoningEffort: 'default',
          mode: 'standard',
          toolPolicy: { allowWrite: false, autoApprove: true },
        },
      },
    } as any;
    const projection = sessionConfigProjection(session);
    expect(projection.toolPolicy).toEqual({
      allowWrite: false,
      autoApprove: true,
      allowUnsandboxed: false,
      sshEnabled: false,
    });
    const changed = sessionConfigProjection({
      ...session,
      resources: { settings: { ...session.resources.settings, toolPolicy: { allowWrite: true } } },
    } as any);
    expect(changed.configRevision).not.toBe(projection.configRevision);
  });

  it('refuses missing trust-boundary prerequisites and unsafe feature flags', () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const base = {
      enabled: false,
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
    };
    expect(() => Term2Gateway.create({ ...base, publicKeys: {} })).toThrowError(new GatewayStartupError());
    expect(() => Term2Gateway.create({ ...base, sshEnabled: true })).toThrowError(new GatewayStartupError());
    expect(() => Term2Gateway.create({ ...base, providerBroker: undefined })).toThrowError(new GatewayStartupError());
    expect(() => Term2Gateway.create({ ...base, workerSandboxAvailable: undefined })).toThrowError(
      new GatewayStartupError(),
    );
    expect(() => Term2Gateway.create({ ...base, manifestSha256: undefined })).toThrowError(new GatewayStartupError());
    expect(() => Term2Gateway.create({ ...base, auditWriter: undefined })).toThrowError(new GatewayStartupError());
  });

  it('requires exactly one transport and validates network TLS configuration', () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = makeManifest(root);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const base = {
      enabled: false,
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
    };
    const certPath = path.join(root, 'cert.pem');
    const keyPath = path.join(root, 'key.pem');
    const caPath = path.join(root, 'ca.pem');
    writeFileSync(certPath, 'test-cert');
    writeFileSync(keyPath, 'test-key');
    writeFileSync(caPath, 'test-ca');
    const network = {
      ...base,
      socketPath: undefined,
      host: '127.0.0.1',
      port: 443,
      tls: { certPath, keyPath, caPath, requireClientCert: true },
    };
    expect(() => assertGatewayStartup({ ...base, socketPath: undefined } as any, manifest)).toThrowError(
      new GatewayStartupError(),
    );
    expect(() => assertGatewayStartup({ ...network, socketPath: path.join(root, 'both.sock') }, manifest)).toThrowError(
      new GatewayStartupError(),
    );
    expect(() => assertGatewayStartup({ ...network, port: 0 }, manifest)).toThrowError(new GatewayStartupError());
    expect(() =>
      assertGatewayStartup({ ...network, tls: { ...network.tls, certPath: path.join(root, 'missing') } }, manifest),
    ).toThrowError(new GatewayStartupError());
    expect(assertGatewayStartup(network, manifest)).toBe(manifest);
  });

  it('refuses a non-absolute socket and never exposes a TCP listener', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
    });
    await gateway.start();
    expect(gateway.server.listening).toBe(true);
    await gateway.shutdown(100);
    expect(gateway.server.listening).toBe(false);
  });

  it('accepts private workspace_list GET and POST and audits inbound correlation IDs', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const auditRecords: Array<{ operation: string; correlationId: string }> = [];
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
      auditWriter: async (record) => {
        if (record.operation === 'workspace_list') auditRecords.push(record);
      },
      tmpDir: path.join(root, 'tmp'),
    });
    const token = () =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-a',
        purpose: 'workspace_list',
      });
    try {
      await gateway.start();
      const socketPath = path.join(root, 'gateway.sock');
      const post = await rpc(socketPath, token(), null, '/private/agent/v1/workspaces', {
        'x-correlation-id': 'browser/correlation-1',
      });
      const get = await rpc(socketPath, token(), null, '/private/agent/v1/workspaces');
      const bounded = await rpc(socketPath, token(), null, '/private/agent/v1/workspaces?limit=1');
      const oversized = await rpc(socketPath, token(), null, '/private/agent/v1/workspaces?limit=51');
      expect(post.status).toBe(200);
      expect(get.status).toBe(200);
      expect(bounded.status).toBe(200);
      expect((bounded.body as { workspaces: unknown[] }).workspaces).toHaveLength(1);
      expect(oversized.status).toBe(400);
      expect(post.body).toMatchObject({ workspaces: expect.any(Array), nextCursor: null });
      expect(get.body).toMatchObject({ workspaces: expect.any(Array), nextCursor: null });
      expect(auditRecords).toHaveLength(4);
      expect(auditRecords[0]!.correlationId).toBe('browser/correlation-1');
      expect(auditRecords.slice(1).every((record) => /^[0-9a-f-]{36}$/.test(record.correlationId))).toBe(true);
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('rejects retarget-shaped and duplicate workspace session_create RPCs', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
    });
    await gateway.start();
    const token = () =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-a',
        purpose: 'session_create',
        workspaceId: 'workspace-a',
      });
    const socketPath = path.join(root, 'gateway.sock');
    expect((await rpc(socketPath, token(), { localRoot: '/tmp/retarget', root: '../outside' })).status).toBe(400);
    const first = await rpc(socketPath, token(), null);
    expect(first.status).toBe(201);
    const duplicate = await rpc(socketPath, token(), null);
    expect(duplicate.status).toBe(409);
    await gateway.shutdown(100);
  });

  it('maps deferred model selection to 422 while other unknown fields stay 400', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
    });
    await gateway.start();
    const token = () =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-a',
        purpose: 'session_create',
        workspaceId: 'workspace-a',
      });
    const socketPath = path.join(root, 'gateway.sock');
    const deferred = await rpc(
      socketPath,
      token(),
      { workspaceId: 'workspace-a', model: 'later' },
      '/private/agent/v1/sessions',
    );
    expect(deferred).toMatchObject({ status: 422, body: { error: { code: 'model_selection_deferred' } } });
    const unknown = await rpc(
      socketPath,
      token(),
      { workspaceId: 'workspace-a', unexpected: true },
      '/private/agent/v1/sessions',
    );
    expect(unknown).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } });
    await gateway.shutdown(100);
  });

  it('rejects path/assertion session mismatches and private attachment fields', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
    });
    const token = (purpose: GatewayAssertionClaims['purpose'], sessionId: string) =>
      createGatewayAssertion({
        privateKey,
        kid: 'active',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-a',
        purpose,
        workspaceId: 'workspace-a',
        sessionId,
      });
    try {
      await gateway.start();
      const socketPath = path.join(root, 'gateway.sock');
      const mismatch = await rpc(
        socketPath,
        token('session_read', 'session-a'),
        null,
        '/private/agent/v1/sessions/session-b',
      );
      expect(mismatch).toMatchObject({ status: 400, body: { error: { code: 'protocol_conflict' } } });
      const legacyRead = await rpc(socketPath, token('session_read', 'session-a'), null, '/');
      expect(legacyRead.status).toBe(404);
      const attachment = await rpc(
        socketPath,
        token('message_submit', 'session-a'),
        { text: 'x', clientRequestId: 'request-a', attachments: [] },
        '/private/agent/v1/sessions/session-a/messages',
      );
      expect(attachment).toMatchObject({ status: 422, body: { error: { code: 'attachments_not_enabled' } } });
    } finally {
      await gateway.shutdown(100);
    }
  });

  it('keeps interaction IDs opaque, asks user questions, increments revisions, and rejects unsafe SSE payloads', () => {
    const first = interactionDtoFromSnapshot(
      {
        interactionId: 1,
        approval: {
          agentName: 'Agent',
          toolName: 'ask_user',
          argumentsText: JSON.stringify({
            questions: [{ question: 'Choose', options: [{ label: 'A' }], is_multi_select: false }],
          }),
        },
        askUserAnswers: [],
        currentAskUserQuestionIndex: 0,
      },
      'public-a',
      1,
    );
    const second = interactionDtoFromSnapshot(
      {
        interactionId: 1,
        approval: {
          agentName: 'Agent',
          toolName: 'ask_user',
          argumentsText: JSON.stringify({
            questions: [
              { question: 'Choose', options: [{ label: 'A' }], is_multi_select: false },
              { question: 'Next', options: [{ label: 'B' }], is_multi_select: false },
            ],
          }),
        },
        askUserAnswers: ['A'],
        currentAskUserQuestionIndex: 1,
      },
      'public-a',
      2,
    );
    expect(first).toMatchObject({ version: 1, interactionId: 'public-a', kind: 'ask_user', revision: 1 });
    expect(second).toMatchObject({ interactionId: 'public-a', kind: 'ask_user', revision: 2 });
    expect((first as { askUser: { questions: Array<Record<string, unknown>> } }).askUser.questions[0]).toMatchObject({
      question: 'Choose',
    });
    expect(
      isPublicEventEnvelope({
        schemaVersion: 1,
        id: 1,
        sessionId: 'session-a',
        type: 'text_delta',
        occurredAt: new Date().toISOString(),
        payload: { turnId: 'turn-a', delta: 'ok' },
      }),
    ).toBe(true);
    expect(
      isPublicEventEnvelope({
        schemaVersion: 1,
        id: 2,
        sessionId: 'session-a',
        type: 'text_delta',
        occurredAt: new Date().toISOString(),
        payload: { turnId: 'turn-a', rawInterruption: 'secret' },
      }),
    ).toBe(false);
  });

  it('accepts exactly the amended private RPC resolve request shape', () => {
    expect(isInteractionResolveRequest({ revision: 1, answer: 'approve' })).toBe(true);
    expect(
      isInteractionResolveRequest({ revision: 2, answer: 'custom', rejectionReason: 'because', approvalAnswer: 'yes' }),
    ).toBe(true);
    for (const invalid of [
      {},
      { answer: 'approve' },
      { revision: 0, answer: 'approve' },
      { revision: -1, answer: 'approve' },
      { revision: 1.5, answer: 'approve' },
      { revision: Number.MAX_SAFE_INTEGER + 1, answer: 'approve' },
      { revision: '1', answer: 'approve' },
      { revision: 1, answer: 'approve', unknown: true },
    ]) {
      expect(isInteractionResolveRequest(invalid)).toBe(false);
    }
  });

  it('keeps submitted-message transcript projections within the frozen BFF allowlist', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
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
          startStream: async () => {
            const stream = createMockStream([{ type: 'final', finalText: 'assistant reply' }]);
            stream.finalOutput = 'assistant reply';
            return stream;
          },
          continueRunStream: async () => createMockStream([]),
        } as ConversationAgentClient),
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
    let gatewayStopped = false;
    try {
      await gateway.start();
      const created = await rpc(
        path.join(root, 'gateway.sock'),
        token('session_create'),
        {
          workspaceId: 'workspace-a',
        },
        '/private/agent/v1/sessions',
      );
      expect(created.status).toBe(201);
      const sessionId = (created.body as { session: { id: string } }).session.id;
      const submitted = await rpc(
        path.join(root, 'gateway.sock'),
        token('message_submit', sessionId),
        { text: 'hello from the user', clientRequestId: 'client-1' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);
      const eventPath = path.join(
        persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!,
        'events.jsonl',
      );
      const eventTypes = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(eventTypes).toEqual(['session_created', 'user_message_accepted', 'assistant_started', 'turn_completed']);
      const admissionAfterCompletion = persistence.index.admission('user-a', sessionId, 'client-1');
      expect(admissionAfterCompletion?.state).toBe('terminal');
      const read = await rpc(
        path.join(root, 'gateway.sock'),
        token('session_read', sessionId),
        null,
        `/private/agent/v1/sessions/${sessionId}`,
      );
      expect(read.status).toBe(200);
      const session = (
        read.body as {
          session: {
            latestSequence: number;
            projectionSequence: number;
            transcript: { messages: Array<Record<string, unknown>> };
          };
        }
      ).session;
      expect(session.projectionSequence).toBe(session.latestSequence);
      assertFrozenTranscript(session.transcript);
      expect(session.transcript.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String), role: 'user', text: 'hello from the user' }),
          expect.objectContaining({ id: expect.any(String), role: 'bot', text: 'assistant reply' }),
        ]),
      );
      expect(session.transcript.messages.every((message) => !String(message.id).startsWith('system-interrupted'))).toBe(
        true,
      );
      expect(session.transcript.messages.every((message) => !('sender' in message))).toBe(true);

      await gateway.shutdown(100);
      gatewayStopped = true;
      const restarted = Term2Gateway.create({
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
        persistence,
      });
      try {
        await restarted.start();
        const reopened = await rpc(
          path.join(root, 'gateway.sock'),
          token('session_read', sessionId),
          null,
          `/private/agent/v1/sessions/${sessionId}`,
        );
        expect(reopened.status).toBe(200);
        const reopenedMessages = (
          reopened.body as { session: { transcript: { messages: Array<Record<string, unknown>> } } }
        ).session.transcript.messages;
        expect(reopenedMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ role: 'bot', text: 'assistant reply' })]),
        );
        expect(reopenedMessages.every((message) => !String(message.id).startsWith('system-interrupted'))).toBe(true);
      } finally {
        await restarted.shutdown(100);
      }
    } finally {
      if (!gatewayStopped) await gateway.shutdown(100);
      persistence.closeIndex();
      await runtimeFactory.shutdown();
    }
  });

  it('keeps an ask_user interaction resolvable across concurrent subscribers', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
    let continuationCalls = 0;
    let startCalls = 0;
    let failContinuation = false;
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
          startStream: async () => {
            startCalls += 1;
            const stream = createMockStream([]);
            stream.interruptions = [
              {
                name: startCalls === 1 ? 'ask_user' : 'shell',
                callId: 'ask-route-1',
                agent: { name: 'Agent' },
                arguments:
                  startCalls === 1
                    ? JSON.stringify({
                        questions: [
                          { question: 'First?', options: [{ label: 'A' }], is_multi_select: false },
                          { question: 'Second?', options: [{ label: 'B' }], is_multi_select: false },
                        ],
                      })
                    : JSON.stringify({ command: 'echo fail' }),
              },
            ];
            stream.state = { kind: 'continuation', approve: () => undefined, reject: () => undefined };
            return stream;
          },
          continueRunStream: async () => {
            continuationCalls += 1;
            if (failContinuation) throw new Error('continuation fixture failure');
            const stream = createMockStream([{ type: 'final', finalText: 'continued' }]);
            stream.finalOutput = 'continued';
            return stream;
          },
        } as ConversationAgentClient),
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
    let secondaryEvents: { status: number; close: () => void } | undefined;
    try {
      await gateway.start();
      const socketPath = path.join(root, 'gateway.sock');
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
        { text: 'ask', clientRequestId: 'ask-client' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(submitted.status).toBe(202);

      let pending: Record<string, any> | undefined;
      for (let attempt = 0; attempt < 30 && !pending; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const read = await rpc(
          socketPath,
          token('session_read', sessionId),
          null,
          `/private/agent/v1/sessions/${sessionId}`,
        );
        pending = (read.body as { session: { interaction?: { interaction?: Record<string, any> } } }).session
          .interaction?.interaction;
      }
      expect(pending).toMatchObject({ kind: 'ask_user', revision: 1 });
      const interactionId = pending!.interactionId as string;
      const [secondaryRead, connectedEvents] = await Promise.all([
        rpc(socketPath, token('session_read', sessionId), null, `/private/agent/v1/sessions/${sessionId}`),
        connectEvents(
          socketPath,
          token('events_connect', sessionId),
          `/private/agent/v1/sessions/${sessionId}/events?after=0`,
        ),
      ]);
      secondaryEvents = connectedEvents;
      expect(secondaryRead.status).toBe(200);
      expect(secondaryRead.body).toMatchObject({
        session: { interaction: { interaction: { interactionId, revision: 1 } } },
      });
      expect(secondaryEvents.status).toBe(200);
      const turnId = (
        await rpc(socketPath, token('session_read', sessionId), null, `/private/agent/v1/sessions/${sessionId}`)
      ).body as { session: { interaction: { turnId: string } } };

      const staleId = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 1, answer: 'option:0' },
        `/private/agent/v1/sessions/${sessionId}/interactions/not-the-current-id`,
      );
      expect(staleId.status).toBe(409);
      expect((staleId.body as { error: { code: string } }).error.code).toBe('stale_interaction');

      const first = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 1, answer: 'option:0' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ accepted: false, interaction: { interactionId, revision: 2 } });

      const afterFirstAnswer = await rpc(
        socketPath,
        token('session_read', sessionId),
        null,
        `/private/agent/v1/sessions/${sessionId}`,
      );
      expect(afterFirstAnswer.status).toBe(200);
      expect(afterFirstAnswer.body).toMatchObject({
        session: { interaction: { state: 'pending', interaction: { interactionId, revision: 2 } } },
      });

      const lateRevision = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 1, answer: 'option:0' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
      );
      expect(lateRevision.status).toBe(409);
      expect((lateRevision.body as { error: { code: string } }).error.code).toBe('stale_interaction');

      const terminal = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 2, answer: 'custom', approvalAnswer: 'B' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
      );
      expect(terminal.status).toBe(202);
      expect(terminal.body).toMatchObject({
        sessionId,
        turnId: turnId.session.interaction.turnId,
        interactionId,
        accepted: true,
      });
      expect((terminal.body as { turnId: string }).turnId).toBe(turnId.session.interaction.turnId);
      expect(continuationCalls).toBe(1);

      const duplicate = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 2, answer: 'option:0' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
      );
      expect(duplicate.status).toBe(409);
      expect((duplicate.body as { error: { code: string } }).error.code).toBe('interaction_already_resolved');
      expect(gateway.interactionMetrics).toMatchObject({
        interaction_presented: 1,
        interaction_updated: 1,
        interaction_resolved: 1,
        interaction_stale: 2,
        interaction_duplicate: 1,
      });

      const eventPath = path.join(
        persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId)!,
        'events.jsonl',
      );
      const eventTypes = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(eventTypes.indexOf('approval_required')).toBeGreaterThanOrEqual(0);
      expect(eventTypes.indexOf('interaction_updated')).toBeGreaterThan(eventTypes.indexOf('approval_required'));
      expect(eventTypes.indexOf('interaction_resolved')).toBeGreaterThan(eventTypes.indexOf('interaction_updated'));

      let completedProjection: {
        session: { transcript: { messages: Array<Record<string, unknown>> } };
      } | null = null;
      for (let attempt = 0; attempt < 30 && !completedProjection; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const projectionRead = await rpc(
          socketPath,
          token('session_read', sessionId),
          null,
          `/private/agent/v1/sessions/${sessionId}`,
        );
        const candidate = projectionRead.body as {
          session: { transcript: { messages: Array<Record<string, unknown>> } };
        };
        if (
          candidate.session.transcript.messages.some(
            (message) => message.role === 'bot' && typeof message.text === 'string' && message.text.length > 0,
          )
        ) {
          completedProjection = candidate;
        }
      }
      expect(completedProjection).not.toBeNull();
      const commands = completedProjection!.session.transcript.messages.flatMap((message) =>
        Array.isArray(message.commands) ? message.commands : [],
      );
      expect(commands).toContainEqual({ callId: 'ask-route-1', toolName: 'ask_user', status: 'completed' });

      failContinuation = true;
      const secondSubmitted = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'fail continuation', clientRequestId: 'ask-client-2' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      expect(secondSubmitted.status).toBe(202);
      let secondPending: Record<string, any> | undefined;
      for (let attempt = 0; attempt < 30 && !secondPending; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const read = await rpc(
          socketPath,
          token('session_read', sessionId),
          null,
          `/private/agent/v1/sessions/${sessionId}`,
        );
        secondPending = (read.body as { session: { interaction?: { interaction?: Record<string, any> } } }).session
          .interaction?.interaction;
      }
      expect(secondPending).toMatchObject({ kind: 'tool_approval', revision: 1 });
      const oldInteractionDuringLiveReplacement = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 2, answer: 'option:0' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${interactionId}`,
      );
      expect(oldInteractionDuringLiveReplacement.status).toBe(409);
      expect((oldInteractionDuringLiveReplacement.body as { error: { code: string } }).error.code).toBe(
        'stale_interaction',
      );
      const failed = await rpc(
        socketPath,
        token('interaction_resolve', sessionId),
        { revision: 1, answer: 'approve' },
        `/private/agent/v1/sessions/${sessionId}/interactions/${secondPending!.interactionId}`,
      );
      expect(failed.status).toBe(503);
      const finalEventTypes = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(finalEventTypes.lastIndexOf('turn_failed')).toBeGreaterThan(
        finalEventTypes.lastIndexOf('interaction_resolved'),
      );
      expect(gateway.interactionMetrics.interaction_continuation_failed).toBe(1);
    } finally {
      // Close the reconnect subscriber before tearing down the gateway.
      secondaryEvents?.close();
      await gateway.shutdown(100);
      persistence.closeIndex();
      await runtimeFactory.shutdown();
    }
  });

  it('rejects a recovered interaction through the real gateway route', async () => {
    const root = makeTemp();
    const manifest = makeManifest(root);
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const admission = new WorkspaceAdmission(manifest, { allowWrite: true, boundaryProbe });
    const binding = admission.admit({ ...claimsFor('session_create'), workspaceId: 'workspace-a' });
    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
    const opened = await persistence.open(binding);
    opened.persistence.interactionCheckpoint.save({
      turnId: 'turn-recovered',
      interaction: {
        version: 1,
        interactionId: 'recovered-interaction',
        kind: 'tool_approval',
        variant: 'ordinary_tool',
        descriptor: { agentName: 'Agent', toolName: 'shell', argumentsText: 'echo safe' },
        choices: [
          { id: 'approve', label: 'Allow' },
          { id: 'reject', label: 'Reject' },
        ],
        revision: 1,
      },
      revision: 1,
      generation: 'generation-recovered',
    });
    await opened.persistence.close();
    await persistence.close(binding.sessionId, 'interrupted');
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
      persistence,
    });
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'interaction_resolve',
      workspaceId: 'workspace-a',
      sessionId: binding.sessionId,
    });
    try {
      await gateway.start();
      const result = await rpc(
        path.join(root, 'gateway.sock'),
        token,
        { revision: 1, answer: 'approve' },
        `/private/agent/v1/sessions/${binding.sessionId}/interactions/recovered-interaction`,
      );
      expect(result.status).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe('interaction_not_resolvable');
    } finally {
      await gateway.shutdown(100);
      persistence.closeIndex();
    }
  });

  it('reopens an indexed session projection after gateway restart', async () => {
    const root = makeTemp();
    const manifest = makeManifest(root);
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const admission = new WorkspaceAdmission(manifest, { allowWrite: true, boundaryProbe });
    const binding = admission.admit({
      ...claimsFor('session_create'),
      workspaceId: 'workspace-a',
    });
    const firstPersistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
    const opened = await firstPersistence.open(binding);
    await opened.persistence.close();
    await firstPersistence.close(binding.sessionId, 'interrupted');
    firstPersistence.closeIndex();
    admission.remove(binding.sessionId);

    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
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
      auditWriter: async () => undefined,
      tmpDir: path.join(root, 'tmp'),
      persistence,
    });
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'session_read',
      workspaceId: 'workspace-a',
      sessionId: binding.sessionId,
    });
    try {
      await gateway.start();
      const read = await rpc(
        path.join(root, 'gateway.sock'),
        token,
        null,
        `/private/agent/v1/sessions/${binding.sessionId}`,
      );
      expect(read).toMatchObject({ status: 200, body: { session: { id: binding.sessionId } } });
    } finally {
      await gateway.shutdown(100);
      persistence.closeIndex();
    }
  });

  it('emits exactly one durable queue-discard event for accepted queued work', async () => {
    const root = makeTemp();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeManifest(root)));
    const persistence = new GatewayPersistenceCoordinator(createGatewayStorageLayout(path.join(root, 'data')));
    let parked: ReturnType<typeof parkedStream> | undefined;
    const runtimeFactory = new RuntimeFactory({
      tmpDir: path.join(root, 'runtime'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      sandboxAvailable: true,
      createAgentClient: () =>
        ({
          chat: async () => '',
          abort: () => parked?.release(),
          setModel: () => {},
          addToolInterceptor: () => () => {},
          startStream: async () => {
            parked ??= parkedStream();
            return parked.stream;
          },
          continueRunStream: async () => createMockStream([]),
        } as ConversationAgentClient),
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
    try {
      await gateway.start();
      const socketPath = path.join(root, 'gateway.sock');
      const created = await rpc(
        socketPath,
        token('session_create'),
        { workspaceId: 'workspace-a' },
        '/private/agent/v1/sessions',
      );
      const sessionId = (created.body as { session: { id: string } }).session.id;
      const first = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'active', clientRequestId: 'active-request' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      const firstTurnId = (first.body as { turnId: string }).turnId;
      await parked!.started;
      const queued = await rpc(
        socketPath,
        token('message_submit', sessionId),
        { text: 'queued', clientRequestId: 'queued-request' },
        `/private/agent/v1/sessions/${sessionId}/messages`,
      );
      const queuedTurnId = (queued.body as { turnId: string }).turnId;
      expect(first.status).toBe(202);
      expect(queued.status).toBe(202);
      const aborted = await rpc(
        socketPath,
        token('abort', sessionId),
        { turnId: firstTurnId },
        `/private/agent/v1/sessions/${sessionId}/abort`,
      );
      expect(aborted.status).toBe(202);
      const sessionPath = persistence.layout.existingSessionPath('user-a', 'workspace-a', sessionId);
      const eventsPath = path.join(sessionPath!, 'events.jsonl');
      const readRejected = () =>
        readFileSync(eventsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
          .filter((event) => event.type === 'user_message_rejected');
      expect(readRejected()).toEqual([
        expect.objectContaining({
          payload: { turnId: queuedTurnId, clientRequestId: 'queued-request', reason: 'queue_discarded' },
        }),
      ]);
      const repeated = await rpc(
        socketPath,
        token('abort', sessionId),
        { turnId: firstTurnId },
        `/private/agent/v1/sessions/${sessionId}/abort`,
      );
      expect(repeated.status).toBe(200);
      expect(readRejected()).toHaveLength(1);
      const abortedRead = await rpc(
        socketPath,
        token('session_read', sessionId),
        null,
        `/private/agent/v1/sessions/${sessionId}`,
      );
      const abortedMessages = (
        abortedRead.body as { session: { transcript: { messages: Array<Record<string, unknown>> } } }
      ).session.transcript.messages;
      expect(abortedMessages.some((message) => String(message.id).startsWith('system-interrupted'))).toBe(true);
    } finally {
      parked?.release();
      await gateway.shutdown(100);
      persistence.closeIndex();
      await runtimeFactory.shutdown();
    }
  });

  it('distinguishes recovered interactions from resolved repeats', () => {
    expect(
      classifyInteractionResolution(
        {
          state: 'recovered',
          interaction: { version: 1 } as any,
          turnId: 'turn-a',
          resolvable: false,
          reason: 'daemon_restart',
        },
        false,
      ),
    ).toBe('interaction_not_resolvable');
    expect(classifyInteractionResolution(null, false)).toBe('interaction_already_resolved');
    expect(
      classifyInteractionResolution({ state: 'pending', interaction: {} as any, turnId: 'turn-a' }, true),
    ).toBeNull();
    expect(
      classifyInteractionResolution(
        {
          state: 'recovered',
          interaction: { version: 1 } as any,
          turnId: 'turn-a',
          resolvable: false,
          reason: 'daemon_restart',
        },
        true,
      ),
    ).toBeNull();
  });

  it('rejects a non-absolute socket before reading deployment state', () => {
    expect(() =>
      Term2Gateway.create({
        enabled: false,
        socketPath: 'gateway.sock',
        manifestPath: '/missing',
        replayDbPath: '/missing',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        publicKeys: { active: publicKey },
        providerBroker: broker,
        providerProbe: { available: true, secretFree: true },
        tmpDir: '/tmp',
      }),
    ).toThrowError(GatewayStartupError);
  });

  it('requires RS256 claims and consumes a valid assertion only once', () => {
    const { verifier } = makeVerifier();
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'session_create',
      workspaceId: 'workspace-a',
      nowSeconds: 1_000,
      jti: 'once',
    });
    expect(verifier.verify(token, 'session_create').sub).toBe('user-a');
    expect(() => verifier.verify(token, 'session_create')).toThrowError(new GatewayAssertionError('replay'));
    const sameJtiDifferentPurpose = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'session_read',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      nowSeconds: 1_000,
      jti: 'once',
    });
    expect(() => verifier.verify(sameJtiDifferentPurpose, 'session_read')).toThrowError(
      new GatewayAssertionError('replay'),
    );
  });

  it.each<
    [
      string,
      {
        expected?: GatewayAssertionClaims['purpose'];
        issuer?: string;
        nowSeconds?: number;
        actual: GatewayAssertionClaims['purpose'];
        code: GatewayAssertionError['code'];
      },
    ]
  >([
    ['wrong purpose', { expected: 'abort', actual: 'session_create', code: 'wrong_purpose' }],
    ['wrong issuer', { issuer: 'other', actual: 'session_create', code: 'invalid_claims' }],
    ['expired', { nowSeconds: 900, actual: 'session_create', code: 'expired' }],
  ])('%s is rejected generically', (_name, input) => {
    const { verifier } = makeVerifier(new MemoryReplayLedger(), () => 1_000);
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: input.issuer ?? 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: input.actual,
      workspaceId: 'workspace-a',
      nowSeconds: input.nowSeconds ?? 1_000,
      jti: crypto.randomUUID(),
    });
    expect(() => verifier.verify(token, input.expected)).toThrowError(new GatewayAssertionError(input.code));
  });

  it('accepts the previous key during rotation and rejects an unknown key', () => {
    const { verifier } = makeVerifier();
    const oldToken = createGatewayAssertion({
      privateKey,
      kid: 'old',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'workspace_list',
      nowSeconds: 1_000,
    });
    expect(verifier.verify(oldToken, 'workspace_list').purpose).toBe('workspace_list');
    const unknownToken = createGatewayAssertion({
      privateKey: secondPrivateKey,
      kid: 'new',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'workspace_list',
      nowSeconds: 1_000,
    });
    expect(() => verifier.verify(unknownToken, 'workspace_list')).toThrowError(
      new GatewayAssertionError('unknown_key'),
    );
    expect(secondPublicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('replay survives a gateway restart through the SQLite ledger', () => {
    const root = makeTemp();
    const dbPath = path.join(root, 'replay.sqlite');
    const first = new SqliteReplayLedger(dbPath);
    const { verifier: firstVerifier } = makeVerifier(first);
    const token = createGatewayAssertion({
      privateKey,
      kid: 'active',
      issuer: 'chatforge-bff',
      audience: 'term2-gateway',
      subject: 'user-a',
      purpose: 'session_read',
      workspaceId: 'workspace-a',
      sessionId: 's1',
      nowSeconds: 1_000,
      jti: 'durable',
    });
    firstVerifier.verify(token, 'session_read');
    first.close();
    const second = new SqliteReplayLedger(dbPath);
    const { verifier: secondVerifier } = makeVerifier(second);
    expect(() => secondVerifier.verify(token, 'session_read')).toThrowError(new GatewayAssertionError('replay'));
    second.close();
  });
});

describe('workspace admission', () => {
  it('binds an owner to a canonical local root and rejects cross-owner access', () => {
    const root = makeTemp();
    const admission = makeAdmission(root);
    const binding = admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }));
    expect(binding.canonicalRoot).toBe(root);
    expect(() =>
      admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a', sub: 'user-b' })),
    ).toThrowError(new WorkspaceAdmissionError('workspace_owner_mismatch'));
    expect(() => admission.getSession(binding.sessionId, 'user-b')).toThrowError(
      new WorkspaceAdmissionError('session_owner_mismatch'),
    );
    expect(() => admission.retarget()).toThrowError(new WorkspaceAdmissionError('session_retarget_forbidden'));
  });

  it('rejects version drift, deleted roots, symlink roots, SSH, and path escapes', () => {
    const root = makeTemp();
    const link = path.join(makeTemp(), 'link');
    symlinkSync(root, link);
    const admission = new WorkspaceAdmission(makeManifest(root, 2), { allowWrite: true, boundaryProbe });
    expect(() => admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }), 1)).toThrowError(
      new WorkspaceAdmissionError('manifest_version_mismatch'),
    );
    expect(() =>
      WorkspaceAdmission.assertPath(
        { sessionId: 's', ownerUserId: 'u', workspaceId: 'w', grantVersion: 1, canonicalRoot: root, access: 'read' },
        '../outside',
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_path_escape'));
    writeFileSync(path.join(root, 'inside'), 'ok');
    expect(
      WorkspaceAdmission.assertPath(
        { sessionId: 's', ownerUserId: 'u', workspaceId: 'w', grantVersion: 1, canonicalRoot: root, access: 'read' },
        'inside',
      ),
    ).toBe(path.join(root, 'inside'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(link), { allowWrite: true, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_root_not_canonical'));
    rmSync(root, { recursive: true, force: true });
    expect(() =>
      new WorkspaceAdmission(makeManifest(root, 3), { allowWrite: true, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_root_unavailable'));
  });

  it('does not advertise SSH or owner/path fields in aliases', () => {
    const root = makeTemp();
    const aliases = new WorkspaceAdmission(makeManifest(root)).listAliases('user-a');
    expect(aliases).toEqual([{ workspaceId: 'workspace-a', label: 'A Workspace', access: 'read_write' }]);
    expect(JSON.stringify(aliases)).not.toContain('ownerUserId');
    expect(JSON.stringify(aliases)).not.toContain(root);
  });

  it('fails closed for write policy, missing boundary evidence, and a swapped mount root', () => {
    const root = makeTemp();
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), { allowWrite: false, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('write_not_allowed'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), { allowWrite: true }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_boundary_unverified'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), {
        allowWrite: true,
        boundaryProbe: () => ({ mountedRoot: path.join(root, 'swapped'), writable: true }),
      }).admit(claimsFor('session_create', { workspaceId: 'workspace-a' })),
    ).toThrowError(new WorkspaceAdmissionError('workspace_boundary_unverified'));
  });

  it('requires opaque workspace IDs and provisioned sanitized labels', () => {
    expect(() =>
      validateGatewayManifest({
        version: 1,
        grants: [
          {
            workspaceId: '/tmp/path',
            ownerUserId: 'u',
            label: 'Label',
            kind: 'local',
            localRoot: '/',
            access: 'read',
            enabled: true,
          },
        ],
      }),
    ).toThrowError(new WorkspaceAdmissionError('manifest_invalid'));
    expect(() =>
      validateGatewayManifest({
        version: 1,
        grants: [
          {
            workspaceId: 'good_id',
            ownerUserId: 'u',
            label: 'bad\nlabel',
            kind: 'local',
            localRoot: '/',
            access: 'read',
            enabled: true,
          },
        ],
      }),
    ).toThrowError(new WorkspaceAdmissionError('manifest_invalid'));
  });

  it('rejects a second live session for one workspace', () => {
    const admission = makeAdmission(makeTemp());
    admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }));
    expect(() => admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }))).toThrowError(
      new WorkspaceAdmissionError('workspace_session_exists'),
    );
  });
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

describe('worker process boundary', () => {
  it('builds explicit secret-free env and proves a child cannot see ambient secrets', async () => {
    const env = createSanitizedWorkerEnv({ sessionId: 's1', tmpDir: '/private/tmp/s1' });
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: { ...env, PROVIDER_API_KEY: undefined, SSH_AUTH_SOCK: undefined },
      encoding: 'utf8',
    });
    const observed = JSON.parse(child.stdout);
    expect(observed.TERM2_SESSION_ID).toBe('s1');
    expect(observed.PROVIDER_API_KEY).toBeUndefined();
    expect(observed.SSH_AUTH_SOCK).toBeUndefined();
    expect(() =>
      createSanitizedWorkerEnv({ sessionId: 's1', tmpDir: '/private/tmp/s1', path: '/bad/KEY' }),
    ).not.toThrow();
    expect(() => assertExplicitSanitizedEnv({ ...env, API_TOKEN: 'secret' })).toThrowError(
      new WorkerBoundaryError('unsafe_environment'),
    );
    await expect(executeShellCommand('ignored', { gatewayMode: true })).rejects.toThrowError(
      new GatewayShellEnvironmentError(),
    );
  });

  it('keeps broker capability secret-free and session composition distinct', () => {
    const rootA = makeTemp();
    const rootB = makeTemp();
    const base = (root: string, id: string) => ({
      sessionId: id,
      ownerUserId: 'u',
      workspaceId: id,
      grantVersion: 1,
      canonicalRoot: root,
      access: 'read' as const,
    });
    const a = composeGatewaySession({
      binding: base(rootA, 'a'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      tmpDir: path.join(rootA, 'tmp'),
      sandboxAvailable: true,
    });
    const b = composeGatewaySession({
      binding: base(rootB, 'b'),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      tmpDir: path.join(rootB, 'tmp'),
      sandboxAvailable: true,
    });
    expect(a.executionContext).not.toBe(b.executionContext);
    expect(a.executionContext.getCwd()).toBe(rootA);
    expect(b.executionContext.getCwd()).toBe(rootB);
    a.dispose();
    b.dispose();
  });

  it('fails closed when provider readiness or sandbox boundary is unavailable', () => {
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: true, secretFree: true },
        tmpDir: '/private/tmp/s',
      }),
    ).toThrowError(new WorkerBoundaryError('sandbox_unavailable'));
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: false, secretFree: false },
        tmpDir: '/tmp/s',
        sandboxAvailable: true,
      }),
    ).toThrowError(new WorkerBoundaryError('provider_unavailable'));
    expect(() =>
      composeGatewaySession({
        binding: {
          sessionId: 's',
          ownerUserId: 'u',
          workspaceId: 'w',
          grantVersion: 1,
          canonicalRoot: '/',
          access: 'read',
        },
        providerBroker: broker,
        providerProbe: { available: true, secretFree: true },
        tmpDir: '/tmp/s',
        sandboxAvailable: false,
      }),
    ).toThrowError(new WorkerBoundaryError('sandbox_unavailable'));
  });
});

describe('gateway-safe logging and lifecycle', () => {
  it('allows only bounded opaque metadata', () => {
    const record = createSafeLogMetadata({
      operation: 'session_create',
      outcome: 'allowed',
      sessionId: 's',
      workspaceId: 'w',
      grantVersion: 1,
      access: 'read',
      reasonCode: 'accepted',
    });
    expect(record.schemaVersion).toBe(1);
    expect(() =>
      createSafeLogMetadata({ operation: 'session_create', outcome: 'allowed', projectPath: '/secret' } as never),
    ).toThrowError(new GatewayLogError());
    expect(() =>
      createSafeLogMetadata({ operation: 'session_create', outcome: 'allowed', reasonCode: 'raw_command' } as never),
    ).toThrowError(new GatewayLogError());
  });

  it('drains workers, rejects new workers, and cleans every handle once', async () => {
    const lifecycle = new GatewayLifecycle();
    let closes = 0;
    const release = lifecycle.registerWorker({
      close: async () => {
        closes += 1;
      },
    });
    expect(lifecycle.activeWorkerCount).toBe(1);
    await lifecycle.shutdown(100);
    expect(closes).toBe(1);
    expect(lifecycle.state).toBe('stopped');
    release();
    expect(() => lifecycle.registerWorker({ close: () => undefined })).toThrow('not accepting');
  });
});
