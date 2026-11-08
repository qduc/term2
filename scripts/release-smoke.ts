#!/usr/bin/env node
/**
 * Release smoke check for a packed term2 tarball: install it outside the repository and
 * run one non-interactive model turn with a tool call.
 *
 *   Replay (default, no credentials; for every release):
 *     pnpm release:smoke --tgz <package.tgz> [--fixture <capture.json>]
 *   Record (once, with a real provider; spends credits):
 *     pnpm release:smoke --record --yes --tgz <package.tgz> --type <provider type>
 *       --upstream <provider base URL> --model <model> --api-key-env <ENV NAME> --out <private file>
 *
 * Recording runs the installed CLI against a loopback proxy that forwards to the real
 * provider and keeps every request/response as a fixture envelope. Sanitize and review it
 * with `pnpm provider:fixture:prepare <file>` (then `--accept`), which files it as
 * `scripts/provider-black-box/fixtures/<type>/cli-release-turn-v1-<type>.json`. Replay serves those
 * real responses from loopback to a fresh install and checks the turn completes with the
 * token the model read through the tool. Request bodies are not compared: the CLI's prompt
 * changes between releases, while this check is about the shipped artifact handling real
 * provider wire output.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRecorder, createRecordingMiddleware } from './provider-black-box/fixture-recorder.js';
import { parseFixtureEnvelope, type FixtureEnvelopeV1 } from './provider-black-box/fixture-envelope.js';
import { resolveSettingsDirectory } from '../src/config/settings/settings-path.js';
import { KNOWN_CUSTOM_PROVIDER_TYPES } from '../src/config/settings/settings-schema.js';

const PROBE = 'cli-release-turn-v1';
const TOKEN = 'kestrel-41-orbit';
const PROMPT =
  'Use the read_file tool to read smoke.txt in the current directory, then reply with only its exact contents.';
const WIRE_FAMILY: Record<string, string> = {
  openai: 'openai-responses',
  'openai-compatible': 'openai-chat',
  'llama.cpp': 'openai-chat',
  opencode: 'openai-chat',
  anthropic: 'anthropic',
  google: 'google',
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = join(repoRoot, 'scripts', 'provider-black-box', 'fixtures');

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);
const root = mkdtempSync(join(tmpdir(), 'term2-release-smoke-'));
const tgz = get('--tgz');
if (!tgz || !existsSync(tgz)) fail('--tgz <path to the packed term2 tarball> is required (run `pnpm pack`).');
try {
  const cli = install(resolve(tgz!));
  if (has('--record')) await record(cli);
  else await replayAll(cli);
} finally {
  if (!has('--keep')) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`[release-smoke] kept ${root}`);
}

async function record(cli: string): Promise<void> {
  if (!has('--yes')) fail('Recording calls a real provider and spends credits. Re-run with --yes.');
  const type = get('--type') ?? 'openai-compatible';
  const upstream = get('--upstream');
  const model = get('--model');
  const keyEnv = get('--api-key-env');
  const out = get('--out');
  if (!(KNOWN_CUSTOM_PROVIDER_TYPES as readonly string[]).includes(type))
    fail(`--type must be one of ${KNOWN_CUSTOM_PROVIDER_TYPES.join(', ')}`);
  if (!upstream || !model || !keyEnv || !out) fail('--upstream, --model, --api-key-env and --out are required.');
  if (!isAbsolute(out!) || out!.startsWith(repoRoot))
    fail('--out must be an absolute path outside the repository: raw recordings are never committed.');
  const apiKey = process.env[keyEnv!];
  if (!apiKey) fail(`${keyEnv} is not set.`);
  const upstreamUrl = new URL(upstream!);
  const recorder = createFixtureRecorder({
    provider: type,
    wireFamily: WIRE_FAMILY[type] ?? type,
    transport: 'http-sse',
    capture: {
      sdkPackage: 'term2-cli',
      apiSdkVersion: cliVersion(cli),
      model: model!,
      modelFamily: type,
      capturedAt: new Date().toISOString(),
      recorderVersion: 'release-smoke-1',
      probeScenario: PROBE,
    },
  });
  const middleware = createRecordingMiddleware({ recorder });
  // Forward every request to the upstream origin; the CLI's base URL keeps the upstream path.
  const proxy = await listen(async (req, body) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined && !['host', 'content-length', 'connection', 'accept-encoding'].includes(key))
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    headers.set('accept-encoding', 'identity');
    const init: RequestInit = { method: req.method, headers, ...(body ? { body } : {}) };
    return middleware({ url: new URL(req.url ?? '/', upstreamUrl.origin), init }, (ctx) => fetch(ctx.url, ctx.init));
  });
  try {
    const baseUrl = `${proxy.url}${upstreamUrl.pathname.replace(/\/$/, '')}`;
    const result = await runTurn(cli, { type, model: model!, baseUrl, apiKey: apiKey! });
    if (result.code !== 0 || !result.stdout.includes(TOKEN))
      fail(
        `The recorded turn did not finish with the token (exit ${result.code}).\n${result.stdout}\n${result.stderr}`,
      );
  } finally {
    await proxy.close();
  }
  const envelope = await recorder.flush();
  mkdirSync(dirname(out!), { recursive: true });
  await writeFile(out!, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  console.log(`Recorded ${envelope.turns.length} exchanges to ${out}.`);
  console.log(`Next: pnpm provider:fixture:prepare ${out}  (review the .review.json, then re-run with --accept)`);
}

async function replayAll(cli: string): Promise<void> {
  const explicit = get('--fixture');
  const fixtures = explicit
    ? [resolve(explicit)]
    : readdirSync(fixturesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(join(fixturesRoot, entry.name))
            .filter((name) => name.startsWith(PROBE) && name.endsWith('.json'))
            .map((name) => join(fixturesRoot, entry.name, name)),
        );
  if (!fixtures.length)
    fail(
      `No ${PROBE} capture is committed yet. Record one with --record (see the header of scripts/release-smoke.ts).`,
    );
  for (const file of fixtures) await replay(cli, parseFixtureEnvelope(await readFile(file, 'utf8')), file);
}

async function replay(cli: string, fixture: FixtureEnvelopeV1, file: string): Promise<void> {
  if (fixture.capture.probeScenario !== PROBE) fail(`${file} is not a ${PROBE} capture.`);
  // Recorded exchanges, served in order per method and path, so a catalog GET racing the
  // first model request cannot take its response.
  const queues = new Map<string, FixtureEnvelopeV1['turns']>();
  for (const turn of fixture.turns) {
    const request = turn.frames.find((frame) => frame.kind === 'http-request');
    if (request?.kind !== 'http-request') continue;
    const key = `${request.method} ${request.urlPath.split('?')[0]}`;
    queues.set(key, [...(queues.get(key) ?? []), turn]);
  }
  const unexpected: string[] = [];
  let served = 0;
  const server = await listen(async (req) => {
    const key = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
    const turn = queues.get(key)?.shift();
    if (!turn) {
      unexpected.push(key);
      return new Response('Not in the release smoke capture', { status: 500 });
    }
    served += 1;
    const head = turn.frames.find((frame) => frame.kind === 'http-response-head');
    const headers = new Headers(head?.kind === 'http-response-head' ? head.headers : {});
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) headers.delete(name);
    let body = '';
    for (const frame of turn.frames)
      if (frame.kind === 'sse-event') body += `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`;
      else if (frame.kind === 'json-body')
        body += typeof frame.body === 'string' ? frame.body : JSON.stringify(frame.body);
    return new Response(body, { status: head?.kind === 'http-response-head' ? head.status : 200, headers });
  });
  try {
    const recordedBase = fixture.turns
      .flatMap((turn) => turn.frames)
      .find((frame) => frame.kind === 'http-request' && frame.method === 'POST');
    // Keep the provider's path prefix (for example /api/v1) in front of the recorded paths.
    const prefix =
      recordedBase?.kind === 'http-request'
        ? recordedBase.urlPath.replace(/\/(chat\/completions|responses|messages|models\/.*)(\?.*)?$/, '')
        : '';
    const result = await runTurn(cli, {
      type: fixture.provider,
      model: fixture.capture.model,
      baseUrl: `${server.url}${prefix}`,
      apiKey: 'release-smoke-replay',
    });
    const posts = [...queues.entries()].filter(([key, turns]) => key.startsWith('POST ') && turns.length);
    const problems = [
      ...(result.code === 0 ? [] : [`exit code ${result.code}`]),
      ...(result.stdout.includes(TOKEN) ? [] : [`stdout lacks the token ${TOKEN}`]),
      ...unexpected.map((key) => `unrecorded request ${key}`),
      ...posts.map(([key, turns]) => `${turns.length} recorded ${key} response(s) never requested`),
    ];
    const label = `${fixture.provider}/${fixture.capture.model} (captured ${fixture.capture.capturedAt}, ${served} exchanges)`;
    if (problems.length)
      fail(
        `Replay failed for ${label}:\n- ${problems.join('\n- ')}\n--- stdout\n${result.stdout}\n--- stderr\n${
          result.stderr
        }`,
      );
    console.log(`[release-smoke] OK ${label}: ${cliVersion(cli)} completed a tool turn from real provider output.`);
  } finally {
    await server.close();
  }
}

function install(tarball: string): string {
  const prefix = join(root, 'prefix');
  const result = spawnSync('npm', ['install', '-g', '--no-audit', '--no-fund', '--prefix', prefix, tarball], {
    encoding: 'utf8',
    cwd: root,
  });
  if (result.status !== 0) fail(`npm install of ${tarball} failed:\n${result.stderr}`);
  const cli = join(prefix, 'bin', 'term2');
  console.log(`[release-smoke] installed ${cliVersion(cli)} from ${tarball}`);
  return cli;
}

function cliVersion(cli: string): string {
  return spawnSync(cli, ['--version'], { encoding: 'utf8', env: isolatedEnv() }).stdout.trim();
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TERM2_CONFIG_DIR: join(home, '.term2'),
    TERM2_CACHE_DIR: join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    CI: '1',
  };
  return env;
}

async function runTurn(
  cli: string,
  provider: { type: string; model: string; baseUrl: string; apiKey: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = isolatedEnv();
  const workspace = join(root, 'work');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'smoke.txt'), `${TOKEN}\n`);
  const settingsDir = resolveSettingsDirectory({ homeDir: env.HOME!, env });
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: {
        retryAttempts: 0,
        modelSelection: { provider: 'release-smoke', model: provider.model },
        contextCompaction: { enabled: false },
      },
      providers: [{ name: 'release-smoke', type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey }],
      sandbox: { enabled: false },
    }),
    { mode: 0o600 },
  );
  const child = spawn(cli, ['--auto-approve', '-q', PROMPT], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const code = await new Promise<number | null>((done) => child.on('close', done));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function listen(
  handle: (req: IncomingMessage, body: string) => Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      handle(req, body)
        .then(async (response) => {
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key))
              headers[key] = value;
          });
          res.writeHead(response.status, headers);
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: unknown) => {
          res.writeHead(502);
          res.end(error instanceof Error ? error.message : String(error));
        });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function fail(message: string): never {
  console.error(`[release-smoke] ${message}`);
  if (!has('--keep')) rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
