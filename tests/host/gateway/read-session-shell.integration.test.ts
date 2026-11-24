import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import type { AssertionPurpose } from '../../../src/host/server-contracts.js';
import { integrationCliPath } from '../../helpers/integration-cli.js';
import { createWorld, removeWorld, writeWorldSettings, type World } from '../../helpers/loopback-chat-world.js';

// Shell in a read-only gateway session, through the real `term2 serve` child, its grant authority, the native
// session and the real shell sandbox. A read session runs every shell command inside the sandbox whatever
// `sandbox.enabled` says, so the sandbox's read-only mount is what refuses a write. When the sandbox cannot run,
// the session offers no shell and its instructions say why. A read & write session with the sandbox off still
// runs commands unsandboxed. Linux only: bubblewrap provides the mounts, and a PATH without `bwrap` is how the
// second case makes the sandbox unavailable without a test-only switch in the product.

const KID = 'read-session-shell-kid';
// The instruction line is the contract the model reads (session/prompts/prompt-constructor.ts).
const READ_ONLY_SHELL_UNAVAILABLE_INSTRUCTION =
  'Shell is unavailable in this read-only folder. Use the read, search, and list tools instead.';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Call = { readonly command: string; readonly sandbox?: 'unsandboxed' };
type Request = {
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};

let world: World | undefined;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  removeWorld(world);
  world = undefined;
});

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : (part as { text?: string }).text ?? '')).join('')
    : JSON.stringify(content);

/**
 * An OpenAI-compatible model double. A request whose latest user message is a key of `scripts` gets that
 * script's next shell call (one per tool result already sent after that message), then `DONE`. Any other
 * request (a title, a verifier) gets `DONE`, so it cannot consume a script step.
 */
async function startModel(scripts: Record<string, readonly Call[]>) {
  const requests: Request[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as Request;
      requests.push(request);
      const lastUser = request.messages.map((message) => message.role).lastIndexOf('user');
      const script = scripts[text(request.messages[lastUser]?.content).trim()] ?? [];
      const step = request.messages.slice(lastUser).filter((message) => message.role === 'tool').length;
      const call = script[step];
      const id = `chatcmpl-${requests.length}`;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ ...call, description: 'Run it' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'DONE' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({ id, choices: [{ delta }] })}`,
          `data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`,
    /** Requests whose latest user message is `prompt`, in order. */
    turn: (prompt: string) =>
      requests.filter((request) => {
        const lastUser = request.messages.map((message) => message.role).lastIndexOf('user');
        return text(request.messages[lastUser]?.content).trim() === prompt;
      }),
  };
}

async function startServe(w: World, options: { allowWrite: boolean; env?: NodeJS.ProcessEnv }) {
  const stateDir = path.join(w.home, 'gateway-state');
  const socketPath = path.join(w.root, 's');
  const tls = process.env.TERM2_TEST_GATEWAY_TLS === '1';
  let port = 0;
  const certPath = path.join(w.root, 'cert.pem');
  const keyPath = path.join(w.root, 'key.pem');
  if (tls) {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    );
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  }
  const publicKeyPath = path.join(w.home, 'bff-public.pem');
  fs.writeFileSync(publicKeyPath, keys.publicKey, 'utf-8');
  const child: ChildProcess = spawn(
    process.execPath,
    [
      integrationCliPath(),
      'serve',
      '--state-dir',
      stateDir,
      ...(tls
        ? ['--listen', `127.0.0.1:${port}`, '--tls-cert', certPath, '--tls-key', keyPath]
        : ['--socket', socketPath]),
      '--local-owner',
      'owner',
      '--bff-key',
      `${KID}=${publicKeyPath}`,
      ...(options.allowWrite ? ['--allow-write'] : []),
    ],
    { env: { ...w.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  cleanup.push(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += chunk));
  child.stdout!.resume();
  await expect
    .poll(() => (child.exitCode === null ? stderr.includes('GATEWAY_READY') : `exited:\n${stderr}`), {
      timeout: 60_000,
      interval: 50,
    })
    .toBe(true);
  const rpc = (
    purpose: AssertionPurpose,
    method: string,
    suffix: string,
    body?: unknown,
    ids: { workspaceId?: string; sessionId?: string } = {},
  ) =>
    new Promise<any>((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const assertion = createGatewayAssertion({
        privateKey: keys.privateKey,
        kid: KID,
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'owner',
        purpose,
        ...ids,
      });
      const request = (tls ? https : http).request(
        {
          ...(tls ? { hostname: '127.0.0.1', port, rejectUnauthorized: false } : { socketPath }),
          method,
          path: `/private/agent/v1${suffix}`,
          headers: {
            'x-term2-assertion': assertion,
            accept: 'application/json',
            ...(encoded === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
          },
        },
        (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (raw += chunk));
          response.on('end', () =>
            response.statusCode! < 400
              ? resolve(raw ? JSON.parse(raw) : {})
              : reject(new Error(`${purpose} ${response.statusCode}: ${raw}\nstderr:\n${stderr}`)),
          );
        },
      );
      request.on('error', reject);
      request.end(encoded);
    });
  const openSession = async (root: string, access: 'read' | 'read_write') => {
    const validated = await rpc('workspace_candidate_validate', 'POST', '/workspace/candidates/validate', {
      absolutePath: root,
    });
    const selected = await rpc('workspace_candidate_select', 'POST', '/workspace/candidates/select', {
      candidateId: validated.candidateId,
      access,
    });
    const workspaceId = selected.workspaceId as string;
    const created = await rpc('session_create', 'POST', '/sessions', { workspaceId }, { workspaceId });
    return created.session.id as string;
  };
  const send = (sessionId: string, prompt: string) =>
    rpc(
      'message_submit',
      'POST',
      `/sessions/${sessionId}/messages`,
      { text: prompt, clientRequestId: prompt },
      {
        sessionId,
      },
    );
  const read = (sessionId: string) => rpc('session_read', 'POST', `/sessions/${sessionId}`, {}, { sessionId });
  const resolve = (sessionId: string, interactionId: string, answer: string) =>
    rpc(
      'interaction_resolve',
      'POST',
      `/sessions/${sessionId}/interactions/${interactionId}`,
      { revision: 1, answer },
      { sessionId },
    );
  return { openSession, send, read, resolve };
}

/** A git repository with one commit, created under the world's home (serve admits folders under HOME). */
function repository(w: World, name: string): string {
  const root = path.join(w.home, name);
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: w.env, stdio: 'pipe' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git('add', 'README.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first-commit-subject');
  return root;
}

const toolNames = (request: Request | undefined) => (request?.tools ?? []).map((tool) => tool.function.name);
const systemText = (request: Request | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => text(message.content))
    .join('\n');
const results = (request: Request | undefined) =>
  (request?.messages ?? []).filter((message) => message.role === 'tool').map((message) => text(message.content));

it.each([true, false])(
  'asks for a scoped web shell escape with sandbox enabled=%s',
  { timeout: 120_000 },
  async (enabled) => {
    world = createWorld('t2s');
    const w = world;
    const root = path.join(w.home, 'workspace');
    fs.mkdirSync(root);
    const allowed = path.join(w.outside, 'allowed.txt');
    const denied = path.join(w.outside, 'denied.txt');
    const model = await startModel({
      allow: [{ command: `printf allowed > ${allowed}`, sandbox: 'unsandboxed' }],
      reject: [{ command: `printf denied > ${denied}`, sandbox: 'unsandboxed' }],
    });
    writeWorldSettings(w, model.baseUrl, {
      sandbox: { enabled },
      shell: { autoApproveMode: 'off' },
      agent: { completionVerification: false },
    });
    const serve = await startServe(w, { allowWrite: true });
    for (const [prompt, answer, target] of [
      ['allow', 'unsandboxed-once', allowed],
      ['reject', 'reject', denied],
    ] as const) {
      const sessionId = await serve.openSession(root, 'read_write');
      await serve.send(sessionId, prompt);
      let interaction: any;
      await expect
        .poll(
          async () => {
            interaction = (await serve.read(sessionId)).session.interaction?.interaction;
            return interaction?.choices?.map((choice: { id: string }) => choice.id);
          },
          { timeout: 60_000 },
        )
        .toContain('unsandboxed-once');
      expect(interaction.choices.map((choice: { id: string }) => choice.id)).not.toContain('approve');
      expect(fs.existsSync(target)).toBe(false);
      await serve.resolve(sessionId, interaction.interactionId, answer);
      await expect.poll(() => model.turn(prompt).length, { timeout: 60_000 }).toBe(2);
      if (answer === 'unsandboxed-once') expect(fs.readFileSync(target, 'utf8')).toBe('allowed');
      else expect(fs.existsSync(target)).toBe(false);
    }
  },
);

it('requires Docker host-control approval in always mode', { timeout: 120_000 }, async () => {
  world = createWorld('t2d');
  const w = world;
  const root = path.join(w.home, 'workspace');
  fs.mkdirSync(root);
  const model = await startModel({ docker: [{ command: 'docker version' }] });
  writeWorldSettings(w, model.baseUrl, {
    sandbox: { enabled: true },
    shell: { autoApproveMode: 'always' },
    agent: { completionVerification: false },
  });
  const serve = await startServe(w, { allowWrite: true });
  const sessionId = await serve.openSession(root, 'read_write');
  await serve.send(sessionId, 'docker');
  let interaction: any;
  await expect
    .poll(
      async () => {
        interaction = (await serve.read(sessionId)).session.interaction?.interaction;
        return interaction?.choices?.map((choice: { id: string }) => choice.id);
      },
      { timeout: 60_000 },
    )
    .toContain('docker-allow-once');
  await serve.resolve(sessionId, interaction.interactionId, 'reject');
  await expect.poll(() => model.turn('docker').length, { timeout: 60_000 }).toBe(2);
});

it.skipIf(process.platform !== 'linux')(
  'a read session runs shell inside the sandbox with sandbox.enabled=false; read & write stays unsandboxed',
  { timeout: 120_000 },
  async () => {
    world = createWorld('term2-read-shell');
    const w = world;
    const readRoot = repository(w, 'read-folder');
    const writeRoot = path.join(w.home, 'write-folder');
    fs.mkdirSync(writeRoot);
    // Outside both folders and the scratch area: only an unsandboxed command can write here.
    const outsideTarget = path.join(w.outside, 'unsandboxed.txt');
    const readPrompt = 'read-session';
    const writePrompt = 'read-write-session';
    const model = await startModel({
      [readPrompt]: [
        { command: 'git log --oneline' },
        // Reads like a log query, writes a file: only the mount can refuse it.
        { command: 'git log -1 --output=gitout.txt' },
        { command: 'printf x > blocked.txt' },
        { command: 'printf x > escaped.txt', sandbox: 'unsandboxed' },
      ],
      [writePrompt]: [{ command: `printf x > ${outsideTarget}` }],
    });
    writeWorldSettings(w, model.baseUrl, {
      sandbox: { enabled: false },
      // No person answers here; approval would otherwise hold the read & write session's write.
      shell: { autoApproveMode: 'always' },
      agent: { completionVerification: false },
    });
    const serve = await startServe(w, { allowWrite: true });

    const readSession = await serve.openSession(readRoot, 'read');
    await serve.send(readSession, readPrompt);
    await expect.poll(() => model.turn(readPrompt).length, { timeout: 60_000 }).toBe(5);
    const readTurn = model.turn(readPrompt);
    expect(toolNames(readTurn[0])).toContain('shell');
    expect(systemText(readTurn[0])).not.toContain(READ_ONLY_SHELL_UNAVAILABLE_INSTRUCTION);
    const [log, gitWrite, write, escape] = results(readTurn[4]);
    expect(log).toMatch(/^exit 0[\s\S]*first-commit-subject/);
    expect(gitWrite).toContain('Read-only file system');
    expect(write).toMatch(/^exit [1-9]/);
    expect(write).toContain('Read-only file system');
    // A read session cannot escape, and must not silently run a different command than requested.
    expect(escape).toContain('outside-sandbox grant');
    expect(escape).toContain('Command not executed');
    expect(fs.readdirSync(readRoot).sort()).toEqual(['.git', 'README.md']);

    const writeSession = await serve.openSession(writeRoot, 'read_write');
    await serve.send(writeSession, writePrompt);
    await expect.poll(() => model.turn(writePrompt).length, { timeout: 60_000 }).toBe(2);
    expect(results(model.turn(writePrompt)[1])).toEqual([expect.stringMatching(/^exit 0/)]);
    expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('x');
  },
);

it.skipIf(process.platform !== 'linux')(
  'a read session whose sandbox cannot run is not offered shell and is told so',
  { timeout: 120_000 },
  async () => {
    world = createWorld('term2-read-noshell');
    const w = world;
    const readRoot = repository(w, 'read-folder');
    // Only node on PATH: no bwrap, so the sandbox runtime reports a missing dependency.
    const bin = path.join(w.root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const prompt = 'no-sandbox';
    const model = await startModel({ [prompt]: [] });
    writeWorldSettings(w, model.baseUrl, { sandbox: { enabled: false }, agent: { completionVerification: false } });
    const serve = await startServe(w, { allowWrite: false, env: { PATH: bin } });

    const session = await serve.openSession(readRoot, 'read');
    await serve.send(session, prompt);
    await expect.poll(() => model.turn(prompt).length, { timeout: 60_000 }).toBe(1);
    const [request] = model.turn(prompt);
    const tools = toolNames(request);
    expect(tools).not.toContain('shell');
    expect(tools).not.toContain('bash');
    expect(tools).toContain('read_file');
    expect(systemText(request)).toContain(READ_ONLY_SHELL_UNAVAILABLE_INSTRUCTION);
  },
);
