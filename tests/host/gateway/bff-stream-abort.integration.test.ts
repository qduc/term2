import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';

/**
 * When the browser leaves, the web server aborts its event stream to the gateway. If the gateway has not
 * sent headers yet, nothing has resolved, and the only thing holding the connection is the abort: this
 * checks that the abort really closes the socket the gateway holds, over a real Unix-socket connection.
 * A gateway that never answers is the worst case: without the abort the connection lives until the
 * 10-minute stream timeout.
 */

// Importing the module builds its default client, which writes a key at this path; keep it out of the tree.
const keyDirectory = await mkdtemp(path.join(os.tmpdir(), 'bff-stream-abort-key-'));
const previousKeyPath = process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = path.join(keyDirectory, 'unused-singleton.pem');
const { Term2GatewayClient } = await import(
  new URL('../../../web-client/lib/server/term2-gateway-client.js', import.meta.url).href
);
afterAll(async () => {
  if (previousKeyPath === undefined) delete process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
  else process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = previousKeyPath;
  await rm(keyDirectory, { recursive: true, force: true });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A gateway stand-in that reads each request and never answers it. */
async function silentGateway(): Promise<{ socketPath: string; requests: http.IncomingMessage[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bff-stream-abort-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request) => {
    requests.push(request);
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

function client(socketPath: string) {
  const instance = new Term2GatewayClient({
    gatewayConfig: {
      enabled: true,
      socketPath,
      keyId: 'fixture',
      issuer: 'test-bff',
      audience: 'test-gateway',
      assertionTtlSec: 30,
      clockSkewSec: 5,
      pairingEnabled: false,
      requestTimeoutMs: 600_000,
      streamTimeoutMs: 600_000,
      maxResponseBytes: 4096,
    },
  });
  // The silent gateway checks no signature; the assertion only has to be present.
  instance.issueAssertion = () => 'fixture-assertion';
  return instance;
}

const streamArgs = (signal: AbortSignal) => ({
  userId: 'local-owner',
  purpose: 'events_connect',
  workspaceId: 'workspace',
  sessionId: 'session',
  rpcPath: '/private/agent/v1/sessions/session/events',
  signal,
});

const closed = (request: http.IncomingMessage): Promise<void> =>
  request.socket.destroyed
    ? Promise.resolve()
    : new Promise((resolve) => request.socket.once('close', () => resolve()));

it('aborting a stream that is still waiting for headers closes the gateway connection and rejects', async () => {
  const gateway = await silentGateway();
  const controller = new AbortController();
  const pending = client(gateway.socketPath).stream(streamArgs(controller.signal));
  const outcome = pending.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

  await expect.poll(() => gateway.requests.length).toBe(1);
  expect(gateway.requests[0]!.url).toBe('/private/agent/v1/sessions/session/events');
  controller.abort();

  expect(await outcome).toBe('gateway_unavailable');
  // The gateway sees its side of the connection close; nothing is left holding it.
  await closed(gateway.requests[0]!);
});

it('a stream started with an already aborted signal rejects and leaves no open connection', async () => {
  const gateway = await silentGateway();
  const controller = new AbortController();
  controller.abort();

  await expect(client(gateway.socketPath).stream(streamArgs(controller.signal))).rejects.toMatchObject({
    code: 'gateway_unavailable',
  });
  // If the request reached the gateway at all, its connection is already closing.
  await Promise.all(gateway.requests.map(closed));
});

it('aborting a session-list stream before headers closes the gateway socket and sends Client API version header', async () => {
  const gateway = await silentGateway();
  const controller = new AbortController();
  const pending = client(gateway.socketPath).stream({
    userId: 'local-owner',
    purpose: 'session_list_events',
    rpcPath: '/private/agent/v1/sessions/events',
    query: '?limit=50',
    signal: controller.signal,
  });
  const outcome = pending.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

  await expect.poll(() => gateway.requests.length).toBe(1);
  expect(gateway.requests[0]!.url).toBe('/private/agent/v1/sessions/events?limit=50');
  expect(gateway.requests[0]!.headers['x-term2-client-api-version']).toBe('1.0');
  controller.abort();

  expect(await outcome).toBe('gateway_unavailable');
  await closed(gateway.requests[0]!);
});
