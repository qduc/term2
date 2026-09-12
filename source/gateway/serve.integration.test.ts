import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createGatewayAssertion } from './assertion.js';
import { getDefaultShellSandboxRunner } from '../utils/shell/sandbox/shell-sandbox-runner.js';
import { resolveSettingsDirectory } from '../services/settings/settings-path.js';
import { createTestChildEnv } from '../test-helpers/terminal-e2e.js';

// The launcher is exercised as a real child process: pair with a pre-shared
// BFF key, admit a dynamic workspace, run one turn against a settings-defined
// mock provider, then SIGTERM and demand a clean exit. The scripted provider
// crosses the process boundary the way a real operator configures one: a
// runtime-defined openai-compatible provider in settings.json pointed at a
// loopback double. The in-process registerProvider seam used by
// runtime-factory.integration.test.ts cannot reach into another process.

const require = createRequire(import.meta.url);

// Same one-compile-per-worktree pattern as cli.integration.test.ts, but in a
// private cache directory so concurrent integration files never race on one
// tsbuildinfo.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const typescriptDir = path.resolve(path.dirname(require.resolve('typescript-7')), '..');
const serveBuildDir = path.join(projectRoot, 'node_modules', '.cache', 'term2-cli-serve-test-build');

let compiledCliPath: string | undefined;
function cliPath(): string {
  if (compiledCliPath) return compiledCliPath;
  fs.mkdirSync(serveBuildDir, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        path.join(typescriptDir, 'bin', 'tsc'),
        '--project',
        'tsconfig.build.json',
        '--outDir',
        serveBuildDir,
        '--incremental',
        '--tsBuildInfoFile',
        path.join(serveBuildDir, 'tsconfig.tsbuildinfo'),
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
  } catch (error: any) {
    throw new Error(
      `Failed to build CLI for tests: ${error.stdout?.toString?.() ?? ''} ${error.stderr?.toString?.() ?? error}`,
    );
  }
  fs.cpSync(path.join(projectRoot, 'source', 'prompts'), path.join(serveBuildDir, 'prompts'), { recursive: true });
  compiledCliPath = path.join(serveBuildDir, 'cli.js');
  return compiledCliPath;
}

/**
 * Minimal OpenAI-compatible provider double: the /models path serves a fixed
 * list and chat completions answer with a one-frame SSE completion, enough
 * for one full real ConversationService turn.
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
    if (body !== undefined) headers['content-type'] = 'application/json';
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
  events: () => Array<{ id: number; type: string; payload: Record<string, any> }>;
  waitFor: (
    predicate: (event: { type: string; payload: Record<string, any> }) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  close: () => void;
} {
  const assertion = sign('user-1', 'events_connect', { sessionId });
  const frames: Array<{ id: number; type: string; payload: Record<string, any> }> = [];
  const req = http.request(
    {
      socketPath,
      method: 'GET',
      path: `/private/agent/v1/sessions/${sessionId}/events?after=0`,
      headers: { 'x-term2-assertion': assertion, accept: 'text/event-stream' },
    },
    (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (dataLine) frames.push(JSON.parse(dataLine.slice('data:'.length).trim()));
          separator = buffer.indexOf('\n\n');
        }
      });
    },
  );
  req.on('error', () => undefined);
  req.end();
  return {
    events: () => [...frames],
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = frames.find(predicate);
        if (found) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`event not received within ${timeoutMs}ms; saw: ${JSON.stringify(frames.map((f) => f.type))}`);
    },
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
          agent: { provider: 'mockprov', model: 'serve-mock-model', retryAttempts: 0 },
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
      [cliPath(), 'serve', '--state-dir', stateDir, '--local-owner', 'user-1', '--bff-key', `${KID}=${publicKeyPath}`],
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

    // State layout: manifest + sha256 derived at startup, replay DB, and the    // always-wired persistence coordinator root. No trust file: pairing off.
    const manifestRaw = fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf-8');
    expect(JSON.parse(manifestRaw)).toMatchObject({ version: 1, grants: [] });
    expect(fs.readFileSync(path.join(stateDir, 'manifest.sha256'), 'utf-8').trim()).toBe(
      createHash('sha256').update(manifestRaw).digest('hex'),
    );
    expect(fs.existsSync(path.join(stateDir, 'replay.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'gateway-data'))).toBe(true);
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

    // Persistence is wired, so session_create must answer the BFF body shape
    // ({ session }) — not the legacy { sessionId, ... } shape.
    const created = await rpc('POST', '/private/agent/v1/sessions', { workspaceId }, 'session_create', { workspaceId });
    const sessionId = created.session?.id as string;
    expect(sessionId).toBeTruthy();

    const stream = openEventStream(socketPath, sessionId);
    const submitted = await rpc(
      'POST',
      `/private/agent/v1/sessions/${sessionId}/messages`,
      { text: 'hello gateway', clientRequestId: 'serve-req-1' },
      'message_submit',
      { sessionId },
    );
    expect(submitted.accepted).toBe(true);

    await stream.waitFor((event) => event.type === 'turn_completed', 45_000);
    const completed = stream.events().find((event) => event.type === 'turn_completed')!;
    expect(completed.payload.outcome).toBe('completed');
    const seen = stream.events().map((event) => event.type);
    expect(seen).toContain('session_created');
    expect(seen).toContain('user_message_accepted');
    expect(seen).toContain('assistant_started');
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
  }, 180_000);

  it('pairs by OTP on stderr, registers the BFF key, and admits sessions under the paired kid', async () => {
    const tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'serve-pair-home-')));
    const stateDir = path.join(tempHome, 'gateway-state');
    const workspaceRoot = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspace = realpathSync(workspaceRoot);
    disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));
    const settingsDir = resolveSettingsDirectory({ homeDir: tempHome });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{}', 'utf-8');

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
