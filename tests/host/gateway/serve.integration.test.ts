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
  ['workspace_files', 'GET', '/workspaces/WORKSPACE/files'],
  ['workspace_candidate_validate', 'POST', '/workspace/candidates/validate'],
  ['workspace_candidate_browse', 'POST', '/workspace/candidates/browse'],
  ['workspace_candidate_select', 'POST', '/workspace/candidates/select'],
  ['workspace_ssh_hosts', 'GET', '/workspaces/ssh-hosts'],
  ['workspace_ssh_add', 'POST', '/workspaces/ssh'],
  ['workspace_remove', 'DELETE', '/workspaces/WORKSPACE'],
  ['workspace_access_update', 'PUT', '/workspaces/WORKSPACE/access'],
  ['settings_read', 'GET', '/settings'],
  ['settings_write', 'PUT', '/settings'],
  ['credential_write', 'POST', '/credentials/test'],
  ['credential_delete', 'DELETE', '/credentials/test'],
  ['oauth_login', 'POST', '/oauth/codex/login'],
  ['oauth_select', 'POST', '/oauth/codex/select'],
  ['oauth_delete', 'DELETE', '/oauth/codex/accounts/test'],
  ['provider_presets', 'GET', '/providers/presets'],
  ['provider_write', 'POST', '/providers'],
  ['provider_delete', 'DELETE', '/providers/test'],
  ['skills_list', 'GET', '/skills'],
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
  ['session_rewind_targets', 'GET', '/sessions/SESSION/rewind-targets'],
  ['session_rewind', 'POST', '/sessions/SESSION/rewind'],
  ['session_queue', 'POST', '/sessions/SESSION/queue'],
  ['session_task_control', 'POST', '/sessions/SESSION/tasks'],
  ['session_files', 'GET', '/sessions/SESSION/files'],
  ['session_quota', 'GET', '/sessions/SESSION/quota'],
  ['session_goal', 'POST', '/sessions/SESSION/goal'],
  ['session_handoff', 'POST', '/sessions/SESSION/handoff'],
  ['protocol_hello', 'GET', '/hello'],
  ['daemon_status', 'GET', '/daemon/status'],
  ['session_list_events', 'GET', '/sessions/events'],
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
    // Keep the workspace inside the temp HOME so cleanup removes everything.
    const workspaceRoot = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'mention-target.txt'), 'draft mentions must be discoverable');
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
    expect(fs.existsSync(path.join(stateDir, 'serve.lock.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'trusted-clients.json'))).toBe(false);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);

    // A second server pointing at the same state directory (even with a distinct socket,
    // as term2-web launches) fails fast instead of colliding later on session locks.
    const duplicateSocketPath = path.join(tempHome, 'duplicate.sock');
    const duplicate = spawn(
      'node',
      [
        cliPath(),
        'serve',
        '--state-dir',
        stateDir,
        '--socket',
        duplicateSocketPath,
        '--local-owner',
        'user-1',
        '--bff-key',
        `${KID}=${publicKeyPath}`,
      ],
      { env: createTestChildEnv({ HOME: tempHome, DISABLE_LOGGING: '1' }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    disposables.push(() => {
      duplicate.kill('SIGKILL');
    });
    let duplicateStderr = '';
    duplicate.stderr.on('data', (chunk: Buffer | string) => {
      duplicateStderr += String(chunk);
    });
    const duplicateExit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`duplicate serve did not fail fast\nstderr:\n${duplicateStderr}`)),
        30_000,
      );
      duplicate.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(duplicateExit.code).toBe(1);
    expect(duplicateStderr).not.toContain('GATEWAY_READY');
    expect(duplicateStderr).toContain('already in use');
    expect(duplicateStderr).toContain(`pid ${child.pid}`);
    expect(fs.existsSync(duplicateSocketPath)).toBe(false);

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
    const listedFiles = await rpc(
      'GET',
      `/private/agent/v1/workspaces/${workspaceId}/files`,
      undefined,
      'workspace_files',
      { workspaceId },
    );
    expect(listedFiles.entries).toContainEqual({ path: 'mention-target.txt', type: 'file' });
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
      const route = `/private/agent/v1${suffix.replace('SESSION', sessionId).replace('WORKSPACE', workspaceId)}`;
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
      } else if (purpose === 'workspace_files') {
        const otherOwner = await socketRequest(
          socketPath,
          method,
          route,
          {},
          sign('other-owner', purpose, { workspaceId }),
        );
        expect(otherOwner.status, `${purpose}: ${otherOwner.raw}`).toBe(403);
        expect(jsonBody(otherOwner).error.code).toBe('workspace_forbidden');
        const mismatchedWorkspace = await socketRequest(
          socketPath,
          method,
          route,
          {},
          sign('user-1', purpose, { workspaceId: 'different-workspace' }),
        );
        expect(mismatchedWorkspace.status).toBe(400);
        expect(jsonBody(mismatchedWorkspace).error.code).toBe('protocol_conflict');
        const missingWorkspaceBinding = await socketRequest(socketPath, method, route, {}, sign('user-1', purpose));
        expect(missingWorkspaceBinding.status).toBe(401);
        const unexpectedSessionBinding = await socketRequest(
          socketPath,
          method,
          route,
          {},
          sign('user-1', purpose, { workspaceId, sessionId }),
        );
        expect(unexpectedSessionBinding.status).toBe(401);
      } else if (/^(settings|credential|oauth|provider|skills|daemon)_/.test(purpose)) {
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
    expect(fs.existsSync(path.join(stateDir, 'serve.lock.pid'))).toBe(false);
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

  it('changes and removes a saved folder grant; stored sessions reopen no wider than they started or than the grant', async () => {
    const tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'serve-grant-edit-')));
    const stateDir = path.join(tempHome, 'gateway-state');
    const workspace = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));

    // The first chat request is held open so a turn is still running when access narrows;
    // later requests answer at once. Each request's tool names are kept to observe the
    // reopened session's tool graph.
    const requests: { tools: string[]; aborted: boolean }[] = [];
    let firstRequestSeen!: () => void;
    const firstRequest = new Promise<void>((resolve) => (firstRequestSeen = resolve));
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'serve-mock-model' }] }));
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer | string) => (raw += String(chunk)));
      req.on('end', () => {
        const body = JSON.parse(raw) as { tools?: { function?: { name?: string }; name?: string }[] };
        const record = {
          tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '').sort(),
          aborted: false,
        };
        requests.push(record);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests.length === 1) {
          res.on('close', () => (record.aborted = !res.writableEnded));
          res.flushHeaders();
          firstRequestSeen();
          return;
        }
        res.end(
          [
            'data: {"id":"chatcmpl-grant","choices":[{"delta":{"role":"assistant","content":"after change"}}]}',
            '',
            'data: {"id":"chatcmpl-grant","choices":[{"delta":{},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    disposables.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const settingsDir = resolveSettingsDirectory({ homeDir: tempHome });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'mockprov', model: 'serve-mock-model' }, retryAttempts: 0 },
        providers: [
          { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
        ],
      }),
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
      { env: createTestChildEnv({ HOME: tempHome, DISABLE_LOGGING: '1' }), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    disposables.push(() => {
      child.kill('SIGKILL');
    });
    let stderr = '';
    // Readiness is announced on stderr after the socket is bound; wait for that line, not a poll.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`readiness timeout\nstderr:\n${stderr}`)), 60_000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`serve exited before readiness (code=${code} signal=${signal})\nstderr:\n${stderr}`));
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk);
        if (stderr.includes('GATEWAY_READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const call = async (
      method: string,
      suffix: string,
      body: unknown,
      purpose: Parameters<typeof sign>[1],
      ids: { workspaceId?: string; sessionId?: string } = {},
      subject = 'user-1',
    ) => {
      const response = await socketRequest(
        socketPath,
        method,
        `/private/agent/v1${suffix}`,
        body,
        sign(subject, purpose, ids),
      );
      return { status: response.status, body: response.raw ? jsonBody(response) : {} };
    };
    const ok = async (...args: Parameters<typeof call>) => {
      const response = await call(...args);
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(400);
      return response.body;
    };
    const grantsPath = path.join(stateDir, 'direct-workspace-grants.json');
    const storedGrants = () => JSON.parse(fs.readFileSync(grantsPath, 'utf-8')).grants as Record<string, unknown>[];

    const validated = await ok(
      'POST',
      '/workspace/candidates/validate',
      { absolutePath: workspace },
      'workspace_candidate_validate',
    );
    const selected = await ok(
      'POST',
      '/workspace/candidates/select',
      { candidateId: validated.candidateId, access: 'read_write' },
      'workspace_candidate_select',
    );
    const workspaceId = selected.workspaceId as string;
    const created = await ok('POST', '/sessions', { workspaceId }, 'session_create', { workspaceId });
    const sessionId = created.session.id as string;
    const logPath = path.join(stateDir, 'conversations', `${sessionId}.jsonl`);

    // A turn is running under read & write when the grant narrows.
    const stream = openEventStream(socketPath, sessionId);
    disposables.push(stream.close);
    await stream.waitFor((event) => event.type === 'configuration', 45_000);
    const first = await ok(
      'POST',
      `/sessions/${sessionId}/messages`,
      { text: 'first', clientRequestId: 'grant-edit-1' },
      'message_submit',
      { sessionId },
    );
    await firstRequest;

    // The assertion must name the workspace in the path; another owner's edit is refused.
    expect(
      await call('PUT', `/workspaces/${workspaceId}/access`, { access: 'read' }, 'workspace_access_update', {
        workspaceId: 'ws_other',
      }),
    ).toMatchObject({ status: 400, body: { error: { code: 'protocol_conflict' } } });
    expect(
      await call(
        'PUT',
        `/workspaces/${workspaceId}/access`,
        { access: 'read' },
        'workspace_access_update',
        { workspaceId },
        'other-owner',
      ),
    ).toMatchObject({ status: 403, body: { error: { code: 'workspace_forbidden' } } });
    expect(
      await call('DELETE', `/workspaces/${workspaceId}`, undefined, 'workspace_remove', { workspaceId }, 'other-owner'),
    ).toMatchObject({ status: 403, body: { error: { code: 'workspace_forbidden' } } });
    expect(
      await call('PUT', `/workspaces/${workspaceId}/access`, { access: 'write' }, 'workspace_access_update', {
        workspaceId,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } });
    expect(storedGrants()).toMatchObject([{ workspaceId, access: 'read_write' }]);

    const narrowed = await ok(
      'PUT',
      `/workspaces/${workspaceId}/access`,
      { access: 'read' },
      'workspace_access_update',
      {
        workspaceId,
      },
    );
    expect(narrowed).toEqual({
      workspace: { workspaceId, label: selected.displayName, access: 'read' },
      grantVersion: selected.binding.grantVersion + 1,
      closedSessions: 1,
    });
    expect(storedGrants()).toMatchObject([{ workspaceId, access: 'read', grantVersion: narrowed.grantVersion }]);
    // Closing the live session cancelled the running turn and its provider request.
    await expect(stream.waitFor(() => false, 10_000)).rejects.toThrow('Event stream ended');
    await expect.poll(() => requests[0]?.aborted, { timeout: 10_000 }).toBe(true);
    expect(readFacts(logPath)).toContainEqual(
      expect.objectContaining({
        type: 'turn_ended',
        turnId: first.turnId,
        outcome: expect.not.stringMatching(/^completed$/),
      }),
    );

    // One completed turn on a session; returns the tool names its provider request carried.
    const runTurn = async (id: string, text: string) => {
      const events = openEventStream(socketPath, id);
      disposables.push(events.close);
      await events.waitFor((event) => event.type === 'configuration', 45_000);
      const turn = await ok(
        'POST',
        `/sessions/${id}/messages`,
        { text, clientRequestId: `grant-edit-${text}` },
        'message_submit',
        { sessionId: id },
      );
      await events.waitFor((event) => event.type === 'turn_ended' && event.turnId === turn.turnId, 45_000);
      events.close();
      return requests.at(-1)!.tools;
    };
    const allowsWrite = async (id: string) =>
      (await ok('POST', `/sessions/${id}/config?format=direct`, {}, 'session_update', { sessionId: id })).toolPolicy
        .allowWrite as boolean;
    const readWriteTools = requests[0]!.tools;

    // A stored session runs with the narrower of its starting access and the current grant.
    // After narrowing, the read & write session still lists and reopens, read-only: no
    // write tools reach the model.
    const forbidden = { status: 403, body: { error: { code: 'workspace_forbidden' } } };
    expect((await ok('GET', '/sessions', undefined, 'session_list')).sessions.map((item: any) => item.id)).toEqual([
      sessionId,
    ]);
    const readOnlyTools = await runTurn(sessionId, 'second');
    const writeTools = readWriteTools.filter((name) => !readOnlyTools.includes(name));
    expect(writeTools.length, JSON.stringify(requests.map((request) => request.tools))).toBeGreaterThan(0);
    expect(readOnlyTools.every((name) => readWriteTools.includes(name))).toBe(true);
    expect(await allowsWrite(sessionId)).toBe(false);

    // Widening is allowed because this server was started with --allow-write. It closes the
    // live session, which reopens still read-only; a new session gets write tools.
    const widened = await ok(
      'PUT',
      `/workspaces/${workspaceId}/access`,
      { access: 'read_write' },
      'workspace_access_update',
      { workspaceId },
    );
    expect(widened).toMatchObject({
      workspace: { access: 'read_write' },
      grantVersion: narrowed.grantVersion + 1,
      closedSessions: 1,
    });
    // The first session started read & write, so it is read & write again.
    expect(await runTurn(sessionId, 'third')).toEqual(readWriteTools);
    expect(await allowsWrite(sessionId)).toBe(true);
    // A session started under the read grant stays read-only after widening.
    expect(
      await ok('PUT', `/workspaces/${workspaceId}/access`, { access: 'read' }, 'workspace_access_update', {
        workspaceId,
      }),
    ).toMatchObject({ workspace: { access: 'read' }, closedSessions: 1 });
    const readSessionId = (await ok('POST', '/sessions', { workspaceId }, 'session_create', { workspaceId })).session
      .id as string;
    expect(await runTurn(readSessionId, 'fourth')).toEqual(readOnlyTools);
    expect(
      await ok('PUT', `/workspaces/${workspaceId}/access`, { access: 'read_write' }, 'workspace_access_update', {
        workspaceId,
      }),
    ).toMatchObject({ workspace: { access: 'read_write' }, closedSessions: 1 });
    expect(await runTurn(readSessionId, 'fifth')).toEqual(readOnlyTools);
    expect(await allowsWrite(readSessionId)).toBe(false);
    const newSessionId = (await ok('POST', '/sessions', { workspaceId }, 'session_create', { workspaceId })).session
      .id as string;
    expect(await runTurn(newSessionId, 'sixth')).toEqual(readWriteTools);
    expect(await allowsWrite(newSessionId)).toBe(true);
    expect(
      (await ok('GET', '/sessions', undefined, 'session_list')).sessions.map((item: any) => item.id).sort(),
    ).toEqual([sessionId, readSessionId, newSessionId].sort());

    // Removal: the grant leaves the list and the file, and its sessions no longer open.
    // The two sessions that just ran are live; listing may have opened the first one too.
    const removed = await ok('DELETE', `/workspaces/${workspaceId}`, undefined, 'workspace_remove', { workspaceId });
    expect(removed).toMatchObject({ workspaceId, removed: true });
    expect(removed.closedSessions).toBeGreaterThanOrEqual(2);
    expect(storedGrants()).toEqual([]);
    expect(
      (await ok('GET', '/workspaces', undefined, 'workspace_list')).workspaces.filter(
        (w: { kind?: string }) => w.kind !== 'host',
      ),
    ).toEqual([]);
    expect((await ok('GET', '/sessions', undefined, 'session_list')).sessions).toEqual([]);
    expect(await call('POST', `/sessions/${sessionId}`, {}, 'session_read', { sessionId })).toMatchObject(forbidden);
    expect(
      await call(
        'POST',
        `/sessions/${sessionId}/messages`,
        { text: 'after removal', clientRequestId: 'grant-edit-removed' },
        'message_submit',
        { sessionId },
      ),
    ).toMatchObject({ status: 403, body: { error: { code: 'workspace_forbidden' } } });
    expect(await call('POST', '/sessions', { workspaceId }, 'session_create', { workspaceId })).toMatchObject({
      status: 403,
      body: { error: { code: 'workspace_forbidden' } },
    });
    expect(
      await call('DELETE', `/workspaces/${workspaceId}`, undefined, 'workspace_remove', { workspaceId }),
    ).toMatchObject({
      status: 403,
      body: { error: { code: 'workspace_forbidden' } },
    });
    // Adding the folder back issues a new grant: the old session stays closed and the
    // list still answers, without it.
    const revalidated = await ok(
      'POST',
      '/workspace/candidates/validate',
      { absolutePath: workspace },
      'workspace_candidate_validate',
    );
    const reselected = await ok(
      'POST',
      '/workspace/candidates/select',
      { candidateId: revalidated.candidateId, access: 'read_write' },
      'workspace_candidate_select',
    );
    expect(reselected.workspaceId).not.toBe(workspaceId);
    expect((await ok('GET', '/sessions', undefined, 'session_list')).sessions).toEqual([]);
    expect(await call('POST', `/sessions/${sessionId}`, {}, 'session_read', { sessionId })).toMatchObject(forbidden);
    expect(requests).toHaveLength(6);

    child.removeAllListeners();
    child.kill('SIGTERM');
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not exit after SIGTERM\nstderr:\n${stderr}`)), 30_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exit).toBe(0);
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
    expect(fs.existsSync(path.join(stateDir, 'serve.lock.pid'))).toBe(false);
  }, 120_000);
});
