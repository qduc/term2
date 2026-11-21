import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { IsolatedWorkspacePaths } from './provider-test-harness.js';

/**
 * Loopback fixtures for the Grok black-box scenarios. Grok talks OpenAI
 * Responses over HTTP to the CLI chat proxy; nothing here touches the network
 * beyond 127.0.0.1.
 *
 * What a real user's host looks like, and how each piece is reproduced:
 *
 * - Credentials: `grok-auth.json` in term2's config directory, written in the
 *   store format `term2 --grok-login` produces. `TERM2_CONFIG_DIR` relocates it
 *   (the same override `resolveGrokAuthPath` honours for every user).
 * - Endpoint: `GROK_BASE_URL`, read by `createGrokStreamedModel`.
 * - Client version: the provider's own lookup chain runs unmodified. The cache
 *   file is seeded under `TERM2_CACHE_DIR`, a `grok` shim goes on `PATH`, and
 *   the x.ai version endpoints are made unreachable by pointing the child's
 *   HTTPS proxy at a loopback listener that refuses every CONNECT. The listener
 *   records the hosts the child tried to reach, so the tests can see both that
 *   the lookup chain reached for x.ai and that nothing left the machine.
 */

export const GROK_FIXTURE_ACCESS_TOKEN = 'grok-fixture-access-token';
export const GROK_FIXTURE_MODEL = 'grok-4.6';
/** `GROK_CLIENT_VERSION_FALLBACK` in grok.provider.ts: the last step of the lookup chain. */
export const GROK_CONSTANT_CLIENT_VERSION = '1.0.62';

export type GrokCapturedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
};

export type GrokReply = (request: GrokCapturedRequest, requestNumber: number, response: ServerResponse) => void;

export type GrokFixtureServer = {
  /** The value for `GROK_BASE_URL`: the proxy's `/v1` root on loopback. */
  readonly baseUrl: string;
  readonly requests: GrokCapturedRequest[];
  close(): Promise<void>;
};

export async function startGrokFixtureServer(reply: GrokReply): Promise<GrokFixtureServer> {
  const requests: GrokCapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const captured: GrokCapturedRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: lowerCaseHeaders(request),
      body: await readJsonBody(request),
    };
    requests.push(captured);
    reply(captured, requests.length, response);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

export type RefusingProxy = {
  /** Environment that routes the child's HTTPS traffic, and only that, to this listener. */
  readonly env: Record<string, string | undefined>;
  /** `host:port` of every CONNECT the child attempted. */
  readonly connects: string[];
  close(): Promise<void>;
};

/** A loopback HTTP proxy that records and refuses every CONNECT, so HTTPS lookups fail without leaving the machine. */
export async function startRefusingProxy(): Promise<RefusingProxy> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(403).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket) => {
    connects.push(request.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  const port = await listen(server);
  const proxyUrl = `http://127.0.0.1:${port}`;
  return {
    env: {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: undefined,
      http_proxy: undefined,
      ALL_PROXY: undefined,
      all_proxy: undefined,
      // The provider endpoint is plain HTTP on loopback and must stay direct.
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    connects,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

/** The credential file `term2 --grok-login` writes: a v2 account store with one active account. */
export async function writeGrokCredentials(
  configDir: string,
  tokens: { access_token: string; expires_at?: number } = {
    access_token: GROK_FIXTURE_ACCESS_TOKEN,
    expires_at: Date.now() + 3_600_000,
  },
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'grok-auth.json'),
    JSON.stringify({
      version: 2,
      activeAccountId: 'fixture-grok-user',
      accounts: [
        {
          id: 'fixture-grok-user',
          label: 'fixture@example.test',
          tokens: { ...tokens, email: 'fixture@example.test', user_id: 'fixture-grok-user' },
          addedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    }),
  );
}

/** The version cache `lookupGrokClientVersion` reads from `TERM2_CACHE_DIR`. */
export async function writeGrokVersionCache(cacheDir: string, version: string, ageMs: number): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, 'grok-client-version.json'),
    JSON.stringify({ version, timestamp: Date.now() - ageMs }),
  );
}

/** A `grok` executable that answers `--version`, for the installed-binary step of the lookup chain. */
export async function writeGrokShim(binDir: string, versionOutput: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, 'grok');
  await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' '${versionOutput}'\n`);
  await chmod(shim, 0o755);
}

export type GrokEnvironmentOptions = {
  server: GrokFixtureServer;
  proxy: RefusingProxy;
  /** A directory holding a `grok` shim, put first on PATH; omitted means no `grok` is installed. */
  shimDir?: string;
  extra?: Record<string, string | undefined>;
};

/**
 * The child environment for a Grok run. The harness already isolates HOME, the
 * XDG roots and `TERM2_CACHE_DIR`; this adds the Grok-specific locations.
 */
export function grokEnvironment(
  paths: IsolatedWorkspacePaths,
  options: GrokEnvironmentOptions,
): Record<string, string | undefined> {
  // Drop any host directory that offers a real `grok`, so the installed-binary step sees only the shim.
  const hostPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, 'grok')))
    .join(delimiter);
  return {
    TERM2_CONFIG_DIR: join(paths.configDir, 'term2'),
    // An empty Grok CLI home, so a login on the machine running the tests never leaks in.
    GROK_HOME: join(paths.configDir, 'grok-home-absent'),
    GROK_BASE_URL: options.server.baseUrl,
    // `execFile('grok')` resolves against PATH.
    PATH: options.shimDir ? `${options.shimDir}${delimiter}${hostPath}` : hostPath,
    TERM2_GROK_API: undefined,
    ...options.proxy.env,
    ...options.extra,
  };
}

export function grokConfigDir(paths: IsolatedWorkspacePaths): string {
  return join(paths.configDir, 'term2');
}

export function grokSettings(overrides: { retryAttempts?: number } = {}): string {
  return JSON.stringify({
    agent: {
      modelSelection: { model: GROK_FIXTURE_MODEL, provider: 'grok' },
      retryAttempts: overrides.retryAttempts ?? 0,
      transport: 'http',
      maxTurns: 20,
    },
    app: { liteMode: true },
    shell: { autoApproveMode: 'off' },
    sandbox: { enabled: true, allowNetworking: false },
  });
}

/* ---- Responses wire frames --------------------------------------------- */

export function createdFrame(responseId: string): Record<string, unknown> {
  return { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } };
}

export function completedFrame(
  responseId: string,
  output: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { type: 'response.completed', response: { id: responseId, status: 'completed', output } };
}

export function messageOutput(text: string): Record<string, unknown> {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

export function textFrames(responseId: string, text: string): Record<string, unknown>[] {
  return [
    createdFrame(responseId),
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_text.done', text },
    { type: 'response.output_item.done', item: messageOutput(text) },
    completedFrame(responseId, [messageOutput(text)]),
  ];
}

export const TOOL_CALL_ID = 'call-grok-fixture';
export const TOOL_ARGUMENTS = JSON.stringify({ command: 'pwd', sandbox: 'unsandboxed' });

export function toolCallFrames(responseId: string, callId = TOOL_CALL_ID): Record<string, unknown>[] {
  const itemId = `item-${callId}`;
  const item = {
    id: itemId,
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: callId,
    name: 'shell',
  };
  const done = { ...item, status: 'completed', arguments: TOOL_ARGUMENTS };
  return [
    createdFrame(responseId),
    { type: 'response.output_item.added', item, output_index: 0 },
    {
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      call_id: callId,
      delta: TOOL_ARGUMENTS,
      output_index: 0,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: itemId,
      call_id: callId,
      arguments: TOOL_ARGUMENTS,
      output_index: 0,
    },
    { type: 'response.output_item.done', item: done, output_index: 0 },
    completedFrame(responseId, [done]),
  ];
}

/** Write a complete SSE reply; `terminate: false` leaves the stream ending without a terminal event by closing it abruptly-but-cleanly. */
export function sendSse(response: ServerResponse, frames: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end();
}

export function sendJsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ error: { message } }));
}

/** Input items of a Responses request body, or an empty list. */
export function inputItems(request: GrokCapturedRequest): Array<Record<string, any>> {
  return Array.isArray(request.body.input) ? (request.body.input as Array<Record<string, any>>) : [];
}

export function toolResultItems(request: GrokCapturedRequest): Array<Record<string, any>> {
  return inputItems(request).filter(
    (item) => item.type === 'function_call_output' || item.type === 'function_call_result',
  );
}

/* ---- plumbing ------------------------------------------------------------ */

function lowerCaseHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Grok fixture got a non-object body');
  return parsed as Record<string, unknown>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Grok fixture did not bind');
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
