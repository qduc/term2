import { writeMockCliSettings } from '../../helpers/mock-cli-settings.js';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import { getDefaultShellSandboxRunner } from '../../../src/tools/shell/sandbox/shell-sandbox-runner.js';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';
import type { WireEvent } from '../../../src/protocol/wire.js';
import { readFacts } from '../../../src/session/log.js';
import { ASSERTION_PURPOSES, type AssertionPurpose } from '../../../src/host/server-contracts.js';

// Independent route inventory: do not generate expected purposes from the matcher.
const PRIVATE_ROUTES: readonly [AssertionPurpose, string, string][] = [
  ['workspace_list', 'GET', '/workspaces'],
  ['workspace_candidate_validate', 'POST', '/workspace/candidates/validate'],
  ['workspace_candidate_browse', 'POST', '/workspace/candidates/browse'],
  ['workspace_candidate_select', 'POST', '/workspace/candidates/select'],
  ['settings_read', 'GET', '/settings'],
  ['settings_write', 'PUT', '/settings'],
  ['credential_write', 'POST', '/credentials/test'],
  ['credential_delete', 'DELETE', '/credentials/test'],
  ['oauth_login', 'POST', '/oauth/codex/login'],
  ['oauth_select', 'POST', '/oauth/codex/select'],
  ['oauth_delete', 'DELETE', '/oauth/codex/accounts/test'],
  ['session_update', 'POST', '/sessions/SESSION/config'],
  ['session_list', 'GET', '/sessions'],
  ['model_list', 'GET', '/models'],
  ['session_create', 'POST', '/sessions'],
  ['session_read', 'POST', '/sessions/SESSION'],
  ['message_submit', 'POST', '/sessions/SESSION/messages'],
  ['command_invoke', 'POST', '/sessions/SESSION/commands'],
  ['interaction_resolve', 'POST', '/sessions/SESSION/interactions/turn-1:approval:1'],
  ['abort', 'POST', '/sessions/SESSION/abort'],
  ['events_connect', 'GET', '/sessions/SESSION/events?format=direct'],
];

// The launcher is exercised as a real child process: pair with a pre-shared
// BFF key, admit a dynamic workspace, run one turn against a settings-defined
// mock provider, then SIGTERM and demand a clean exit. The scripted provider
// crosses the process boundary the way a real operator configures one: a
// runtime-defined openai-compatible provider in settings.json pointed at a
// loopback double. The in-process registerProvider seam used by
// runtime-factory.integration.test.ts cannot reach into another process.

import { integrationCliPath as cliPath } from '../../helpers/integration-cli.js';

/**
 * Minimal OpenAI-compatible provider double: the /models path serves a fixed
 * list and chat completions answer with a one-frame SSE completion, enough
 * for one full native Session turn.
 */
async function startModelMock(modelIds: string[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id })) }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          'data: {"id":"chatcmpl-serve","choices":[{"delta":{"role":"assistant","content":"mock gateway turn"}}]}',
          '',
          'data: {"id":"chatcmpl-serve","choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function socketRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body: unknown,
  assertion?: string,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(JSON.stringify(body)));
    }
    if (assertion !== undefined) headers['x-term2-assertion'] = assertion;
    const req = http.request({ socketPath, method, path: requestPath, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer | string) => {
        raw += String(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function jsonBody(response: { status: number; raw: string }): Record<string, any> {
  return JSON.parse(response.raw) as Record<string, any>;
}

function sign(
  subject: string,
  purpose: Parameters<typeof createGatewayAssertion>[0]['purpose'],
  ids: { workspaceId?: string; sessionId?: string } = {},
): string {
  return createGatewayAssertion({
    privateKey: privateKeyPem,
    kid: KID,
    // Deliberately the ChatForge BFF defaults: serve must accept them.
    issuer: 'chatforge-bff',
    audience: 'term2-gateway',
    subject,
    purpose,
    ...ids,
  });
}

function openEventStream(
  socketPath: string,
  sessionId: string,
): {
  events: () => readonly WireEvent[];
  waitFor: (predicate: (event: WireEvent) => boolean, timeoutMs: number) => Promise<WireEvent>;
  close: () => void;
} {
  const assertion = sign('user-1', 'events_connect', { sessionId });
  const frames: WireEvent[] = [];
  const listeners = new Set<() => void>();
  let failure: Error | undefined;
  const changed = () => listeners.forEach((listener) => listener());
  const fail = (error: Error) => {
    failure = error;
    changed();
  };
  const req = http.request(
    {
      socketPath,
      method: 'GET',
      path: `/private/agent/v1/sessions/${sessionId}/events?format=direct&after=0`,
      headers: { 'x-term2-assertion': assertion, accept: 'text/event-stream' },
    },
    (res) => {
      try {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.headers['x-term2-event-format']).toBe('direct-wire-v1');
      } catch (error) {
        fail(error as Error);
        res.destroy();
        return;
      }
      let buffer = '';
      res.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (dataLine) {
            try {
              frames.push(JSON.parse(dataLine.slice('data:'.length).trim()) as WireEvent);
            } catch (error) {
              fail(error as Error);
              res.destroy();
              return;
            }
            changed();
          }
          separator = buffer.indexOf('\n\n');
        }
      });
      res.on('error', fail);
      res.on('end', () => fail(new Error('Event stream ended before the awaited event')));
    },
  );
  req.on('error', fail);
  req.end();
  return {
    events: () => [...frames],
    waitFor: (predicate, timeoutMs) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = frames.find(predicate);
          if (!found && !failure) return;
          clearTimeout(timer);
          listeners.delete(check);
          if (found) resolve(found);
          else reject(failure);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(`event not received within ${timeoutMs}ms; saw: ${JSON.stringify(frames.map((f) => f.type))}`),
          );
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
    close: () => req.destroy(),
  };
}

const KID = 'm2-serve-test-kid';
const { privateKey: privateKeyPem, publicKey: publicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const disposables: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const dispose of disposables.splice(0).reverse()) {
    await dispose();
  }
});

describe('term2 serve (child process)', () => {
  it('pairs, admits a dynamic workspace, creates a persisted session, completes a turn, and exits cleanly on SIGTERM', async () => {
    const tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'serve-home-')));
    const stateDir = path.join(tempHome, 'gateway-state');
    // The launcher's default dynamic-workspace allowlist is the operator's
    // home, so the candidate workspace must live under the child's HOME.
    const workspaceRoot = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspace = realpathSync(workspaceRoot);
    disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));

    const mock = await startModelMock(['serve-mock-model']);
    disposables.push(mock.close);
    const settingsDir = resolveSettingsDirectory({ homeDir: tempHome });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify(
        {
          agent: { modelSelection: { provider: 'mockprov', model: 'serve-mock-model' }, retryAttempts: 0 },
          providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
        },
        null,
        2,
      ),
      'utf-8',
    );
    const publicKeyPath = path.join(tempHome, 'bff-public.pem');
    fs.writeFileSync(publicKeyPath, publicKeyPem, 'utf-8');

    const socketPath = path.join(stateDir, 'gateway.sock');
    const child = spawn(
      'node',
      [
        cliPath(),
        'serve',
        '--state-dir',
        stateDir,
        '--local-owner',
        'user-1',
        '--bff-key',
        `${KID}=${publicKeyPath}`,
        '--allow-write',
      ],
      { env: createTestChildEnv({ HOME: tempHome, DISABLE_LOGGING: '1' }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    disposables.push(() => {
      child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    const exitedEarly = new Promise<never>((_, reject) => {
      child.on('close', (code, signal) =>
        reject(new Error(`serve exited before readiness (code=${code} signal=${signal})\nstderr:\n${stderr}`)),
      );
    });

    // Readiness is announced on stderr, after the socket is bound.
    const deadline = Date.now() + 60_000;
    while (!stderr.includes('GATEWAY_READY')) {
      if (Date.now() > deadline) throw new Error(`readiness timeout\nstderr:\n${stderr}`);
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 100)), exitedEarly]);
    }
    expect(stderr).not.toContain('PAIRING OTP');

    // The launcher warns on stderr when the shell sandbox runner is unusable
    // on this host (and stays silent when it is available).
    const sandboxAvailability = await getDefaultShellSandboxRunner().availability();
    if (sandboxAvailability.type !== 'available') {
      expect(stderr).toContain('shell sandbox unavailable');
      expect(stderr).toContain('GATEWAY_READY');
    }

    // Native state never creates the retired gateway manifest or persistence root.
    // Grants and conversation logs are created only when admitted below.
    expect(fs.existsSync(path.join(stateDir, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'manifest.sha256'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'gateway-data'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'replay.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'trusted-clients.json'))).toBe(false);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);

    const rpc = async (
      method: string,
      requestPath: string,
      body: unknown,
      purpose: Parameters<typeof sign>[1],
      ids: { workspaceId?: string; sessionId?: string } = {},
    ) => {
      const response = await socketRequest(socketPath, method, requestPath, body, sign('user-1', purpose, ids));
      expect(response.status, response.raw).toBeLessThan(400);
      return jsonBody(response);
    };

    await rpc('POST', '/private/agent/v1/workspaces', null, 'workspace_list');
    const validated = await rpc(
      'POST',
      '/private/agent/v1/workspace/candidates/validate',
      { absolutePath: workspace },
      'workspace_candidate_validate',
    );
    expect(validated.valid).toBe(true);
    const selected = await rpc(
      'POST',
      '/private/agent/v1/workspace/candidates/select',
      { candidateId: validated.candidateId, access: 'read' },
      'workspace_candidate_select',
    );
    const workspaceId = selected.workspaceId as string;
    expect(workspaceId).toBeTruthy();
    const grantsPath = path.join(stateDir, 'direct-workspace-grants.json');
    expect(JSON.parse(fs.readFileSync(grantsPath, 'utf-8'))).toEqual({
      version: 1,
      grants: [
        {
          workspaceId,
          ownerUserId: 'user-1',
          label: selected.displayName,
          root: workspace,
          access: 'read',
          grantVersion: selected.binding.grantVersion,
        },
      ],
    });
    expect(fs.statSync(grantsPath).mode & 0o777).toBe(0o600);

    // The public create response and the native log must identify the same owner and grant.
    const created = await rpc('POST', '/private/agent/v1/sessions', { workspaceId }, 'session_create', { workspaceId });
    const sessionId = created.session?.id as string;
    expect(sessionId).toBeTruthy();
    expect(PRIVATE_ROUTES.map(([purpose]) => purpose).sort()).toEqual([...ASSERTION_PURPOSES].sort());
    for (const [purpose, method, suffix] of PRIVATE_ROUTES) {
      const route = `/private/agent/v1${suffix.replace('SESSION', sessionId)}`;
      const unauthenticated = await socketRequest(socketPath, method, route, {});
      expect(unauthenticated.status, `${purpose}: ${unauthenticated.raw}`).toBe(401);
      const wrongPurpose = purpose === 'model_list' ? 'workspace_list' : 'model_list';
      const mismatch = await socketRequest(socketPath, method, route, {}, sign('user-1', wrongPurpose));
      expect(mismatch.status, `${purpose}: ${mismatch.raw}`).toBe(400);
      expect(jsonBody(mismatch).error.code).toBe('protocol_conflict');
      if (suffix.includes('SESSION')) {
        const wrongSession = await socketRequest(
          socketPath,
          method,
          route,
          {},
          sign('user-1', purpose, { sessionId: 'different-session' }),
        );
        expect(wrongSession.status, purpose).toBe(400);
        const otherOwner = await socketRequest(
          socketPath,
          method,
          route,
          {},
          sign('other-owner', purpose, { sessionId }),
        );
        expect(otherOwner.status, `${purpose}: ${otherOwner.raw}`).toBe(404);
      } else if (/^(settings|credential|oauth)_/.test(purpose)) {
        const otherOwner = await socketRequest(socketPath, method, route, {}, sign('other-owner', purpose));
        expect(otherOwner.status, purpose).toBe(403);
        expect(jsonBody(otherOwner).error.code).toBe('settings_forbidden');
      }
    }
    const replayAssertion = sign('user-1', 'workspace_list');
    expect(
      (await socketRequest(socketPath, 'GET', '/private/agent/v1/workspaces', undefined, replayAssertion)).status,
    ).toBe(200);
    expect(
      (await socketRequest(socketPath, 'GET', '/private/agent/v1/workspaces', undefined, replayAssertion)).status,
    ).toBe(401);
    await rpc('GET', '/private/agent/v1/workspaces', undefined, 'workspace_list');
    await rpc('POST', '/', { workspaceId }, 'session_create', { workspaceId });
    const read = await rpc('POST', `/private/agent/v1/sessions/${sessionId}`, {}, 'session_read', { sessionId });
    const v2Read = await rpc(
      'POST',
      `/private/agent/v1/sessions/${sessionId}?format=agent-wire-v2`,
      {},
      'session_read',
      { sessionId },
    );
    expect(v2Read).toMatchObject({ schemaVersion: 2, kind: 'snapshot', sessionId });
    expect(v2Read.snapshot.sessionId).toBe(sessionId);
    expect(read.session.id).toBe(sessionId);
    expect(
      (
        await socketRequest(
          socketPath,
          'GET',
          `/private/agent/v1/sessions/${sessionId}`,
          undefined,
          sign('user-1', 'session_read', { sessionId }),
        )
      ).status,
    ).toBe(404);
    const logPath = path.join(stateDir, 'conversations', `${sessionId}.jsonl`);
    expect(readFacts(logPath)[0]).toMatchObject({
      type: 'session_started',
      id: sessionId,
      workspace,
      model: { provider: 'mockprov', model: 'serve-mock-model' },
      binding: { client: 'user-1', id: workspaceId },
    });

    // #149: dropped HTTP modes fail atomically; retained aliases still configure the real Session.
    const configPath = `/private/agent/v1/sessions/${sessionId}/config?format=direct`;
    const unqualifiedEvents = await socketRequest(
      socketPath,
      'GET',
      `/private/agent/v1/sessions/${sessionId}/events`,
      undefined,
      sign('user-1', 'events_connect', { sessionId }),
    );
    expect(unqualifiedEvents.status).toBe(400);
    expect(jsonBody(unqualifiedEvents).error).toMatchObject({
      code: 'protocol_upgrade_required',
      retryable: false,
      details: { requiredFormat: 'agent-wire-v2' },
    });
    const unkeyedConfig = await socketRequest(
      socketPath,
      'POST',
      configPath,
      { mode: 'bare' },
      sign('user-1', 'session_update', { sessionId }),
    );
    expect(unkeyedConfig.status).toBe(400);
    expect(jsonBody(unkeyedConfig).error).toMatchObject({
      code: 'protocol_upgrade_required',
      retryable: false,
      details: { requiredFields: ['clientRequestId', 'expectedRevision'] },
    });
    let config = await rpc('POST', configPath, {}, 'session_update', { sessionId });
    expect(config.mode).toBe('bare');
    for (const mode of ['plan', 'pair', 'mentor', 'orchestrator']) {
      const rejected = await socketRequest(
        socketPath,
        'POST',
        configPath,
        { clientRequestId: `dropped-${mode}`, expectedRevision: config.configRevision, mode },
        sign('user-1', 'session_update', { sessionId }),
      );
      expect(rejected.status, rejected.raw).toBe(400);
      const unchanged = await rpc('POST', configPath, {}, 'session_update', { sessionId });
      expect(unchanged).toEqual(config);
    }
    for (const mode of ['standard', 'bare', 'lite']) {
      await rpc(
        'POST',
        configPath,
        { clientRequestId: `retained-${mode}`, expectedRevision: config.configRevision, mode },
        'session_update',
        { sessionId },
      );
      config = await rpc('POST', configPath, {}, 'session_update', { sessionId });
      expect(config.mode).toBe('bare');
    }

    const stream = openEventStream(socketPath, sessionId);
    disposables.push(stream.close);
    await stream.waitFor((event) => event.type === 'configuration' && event.sessionId === sessionId, 45_000);
    const submitted = await rpc(
      'POST',
      `/private/agent/v1/sessions/${sessionId}/messages`,
      { text: 'hello gateway', clientRequestId: 'serve-req-1' },
      'message_submit',
      { sessionId },
    );
    expect(submitted.accepted).toBe(true);
    expect(submitted.turnId).toBeTruthy();

    const completed = await stream.waitFor(
      (event) => event.type === 'turn_ended' && event.turnId === submitted.turnId,
      45_000,
    );
    expect(completed).toMatchObject({
      sessionId,
      payload: { outcome: 'completed', finalText: 'mock gateway turn' },
    });
    expect(stream.events()).toContainEqual(
      expect.objectContaining({
        type: 'turn_started',
        sessionId,
        turnId: submitted.turnId,
        payload: expect.objectContaining({
          foreground: true,
          admission: expect.objectContaining({ kind: 'started', clientRequestId: 'serve-req-1' }),
        }),
      }),
    );
    stream.close();

    // Bounded shutdown: clean exit code and the socket file removed.
    child.removeAllListeners();
    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not exit after SIGTERM\nstderr:\n${stderr}`)), 30_000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(exit.code).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(stdout + stderr).not.toContain('PAIRING OTP');
    const facts = readFacts(logPath);
    expect(facts).toContainEqual(
      expect.objectContaining({
        type: 'turn_started',
        turnId: submitted.turnId,
        submission: expect.objectContaining({ clientRequestId: 'serve-req-1' }),
      }),
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        type: 'turn_ended',
        turnId: submitted.turnId,
        outcome: 'completed',
      }),
    );
  }, 180_000);

  it('pairs by OTP on stderr, registers the BFF key, and admits sessions under the paired kid', async () => {
    const tempHome = realpathSync(mkdtempSync(path.join('/tmp', 'serve-pair-')));
    const stateDir = path.join(tempHome, 'gateway-state');
    const workspaceRoot = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspace = realpathSync(workspaceRoot);
    disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));
    writeMockCliSettings(tempHome);

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // kid === fingerprint for a paired client: the lowercase hex SHA-256 of
    // the key's SPKI DER (TrustedClientsStore.normalizePublicKey).
    const expectedKid = createHash('sha256')
      .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
      .digest('hex');

    const socketPath = path.join(stateDir, 'gateway.sock');
    const child = spawn('node', [cliPath(), 'serve', '--state-dir', stateDir, '--local-owner', 'user-1', '--pairing'], {
      env: createTestChildEnv({ HOME: tempHome, DISABLE_LOGGING: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    disposables.push(() => {
      child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    const exitedEarly = new Promise<never>((_, reject) => {
      child.on('close', (code, signal) =>
        reject(new Error(`serve exited before readiness (code=${code} signal=${signal})\nstderr:\n${stderr}`)),
      );
    });

    const deadline = Date.now() + 60_000;
    while (!stderr.includes('GATEWAY_READY')) {
      if (Date.now() > deadline) throw new Error(`readiness timeout\nstderr:\n${stderr}`);
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 100)), exitedEarly]);
    }

    // The OTP is the out-of-band secret: stderr only, never stdout.
    const otpMatch = stderr.match(/PAIRING OTP: (\d{6})/);
    expect(otpMatch).toBeTruthy();
    expect(stdout.trim()).toBe('');

    const registered = await socketRequest(socketPath, 'POST', '/private/agent/v1/pairing/register', {
      publicKeyPem: publicKey,
      otp: otpMatch![1],
    });
    expect(registered.status, registered.raw).toBe(200);
    const registeredBody = JSON.parse(registered.raw) as { paired: boolean; kid: string };
    expect(registeredBody.paired).toBe(true);
    expect(registeredBody.kid).toBe(expectedKid);
    expect(fs.existsSync(path.join(stateDir, 'trusted-clients.json'))).toBe(true);

    const signPaired = (
      purpose: Parameters<typeof createGatewayAssertion>[0]['purpose'],
      ids: { workspaceId?: string; sessionId?: string } = {},
    ) =>
      createGatewayAssertion({
        privateKey,
        kid: registeredBody.kid,
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'user-1',
        purpose,
        ...ids,
      });
    const rpc = async (
      method: string,
      requestPath: string,
      body: unknown,
      purpose: Parameters<typeof createGatewayAssertion>[0]['purpose'],
      ids: { workspaceId?: string; sessionId?: string } = {},
    ) => {
      const response = await socketRequest(socketPath, method, requestPath, body, signPaired(purpose, ids));
      expect(response.status, response.raw).toBeLessThan(400);
      return jsonBody(response);
    };

    const validated = await rpc(
      'POST',
      '/private/agent/v1/workspace/candidates/validate',
      { absolutePath: workspace },
      'workspace_candidate_validate',
    );
    expect(validated.valid).toBe(true);
    const selected = await rpc(
      'POST',
      '/private/agent/v1/workspace/candidates/select',
      { candidateId: validated.candidateId, access: 'read' },
      'workspace_candidate_select',
    );
    const created = await rpc(
      'POST',
      '/private/agent/v1/sessions',
      { workspaceId: selected.workspaceId },
      'session_create',
      { workspaceId: selected.workspaceId },
    );
    expect(created.session?.id).toBeTruthy();

    child.removeAllListeners();
    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not exit after SIGTERM\nstderr:\n${stderr}`)), 30_000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(exit.code).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 120_000);
});
