import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from './server.js';
import { GatewayLifecycle } from './lifecycle.js';
import type { GatewayAssertionClaims } from './contracts.js';
import type { AssertionVerifier } from './assertion.js';

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-server-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const claims: GatewayAssertionClaims = {
  iss: 'bff',
  aud: 'gateway',
  sub: 'owner-a',
  purpose: 'session_list',
  iat: 1,
  nbf: 1,
  exp: 2,
  jti: 'jti-a',
  ver: 1,
};

function call(
  socketPath: string,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        { socketPath, method: options.method, path: options.path, headers: options.headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    },
  );
}

describe('GatewayServer private socket transport', () => {
  it('verifies before routing, supports GET and POST, and passes the parsed URL', async () => {
    const root = makeRoot();
    const seen: Array<{ method: string; pathname: string; body: unknown; correlationId?: string }> = [];
    const server = new GatewayServer({
      socketPath: path.join(root, 'gateway.sock'),
      verifier: { verify: () => claims } as unknown as AssertionVerifier,
      lifecycle: new GatewayLifecycle(),
      handler: async ({ request, body, url, correlationId }) => {
        seen.push({
          method: request.method!,
          pathname: url.pathname,
          body,
          ...(correlationId ? { correlationId } : {}),
        });
        return { status: 200, body: { ok: true } };
      },
    });
    await server.start();
    const get = await call(path.join(root, 'gateway.sock'), {
      method: 'GET',
      path: '/private/agent/v1/sessions?limit=20',
      headers: { 'x-term2-assertion': 'token', 'x-correlation-id': 'corr-123' },
    });
    const post = await call(path.join(root, 'gateway.sock'), {
      method: 'POST',
      path: '/private/agent/v1/sessions/s1/messages',
      headers: { 'x-term2-assertion': 'token', 'content-type': 'application/json' },
      body: '{"text":"hi"}',
    });
    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(seen).toEqual([
      { method: 'GET', pathname: '/private/agent/v1/sessions', body: null, correlationId: 'corr-123' },
      { method: 'POST', pathname: '/private/agent/v1/sessions/s1/messages', body: { text: 'hi' } },
    ]);
    await server.close();
  });

  it('rejects malformed correlation IDs before invoking the handler', async () => {
    const root = makeRoot();
    let calls = 0;
    const server = new GatewayServer({
      socketPath: path.join(root, 'gateway.sock'),
      verifier: { verify: () => claims } as unknown as AssertionVerifier,
      handler: async () => {
        calls += 1;
        return { status: 200, body: { ok: true } };
      },
    });
    await server.start();
    const response = await call(path.join(root, 'gateway.sock'), {
      method: 'GET',
      path: '/private/agent/v1/sessions',
      headers: { 'x-term2-assertion': 'token', 'x-correlation-id': 'bad\\nvalue' },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'validation_error' } });
    expect(calls).toBe(0);
    await server.close();
  });

  it('emits streaming responses without a DONE sentinel and rejects unsupported media', async () => {
    const root = makeRoot();
    const server = new GatewayServer({
      socketPath: path.join(root, 'gateway.sock'),
      verifier: { verify: () => ({ ...claims, purpose: 'events_connect' }) } as unknown as AssertionVerifier,
      handler: async ({ request }) => {
        if (request.headers['content-type'])
          return { status: 415, body: { error: { code: 'unsupported_media_type', message: 'json only' } } };
        return {
          status: 200,
          body: null,
          headers: { 'content-type': 'text/event-stream' },
          stream: {
            start: async (response: import('node:http').ServerResponse) => {
              response.write('id: 1\ndata: {"schemaVersion":1,"id":1}\n\n');
              response.end();
            },
          },
        };
      },
    });
    await server.start();
    const stream = await call(path.join(root, 'gateway.sock'), {
      method: 'GET',
      path: '/private/agent/v1/sessions/s1/events',
      headers: { 'x-term2-assertion': 'token' },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('id: 1');
    expect(stream.body).not.toContain('[DONE]');
    const unsupported = await call(path.join(root, 'gateway.sock'), {
      method: 'POST',
      path: '/private/agent/v1/sessions/s1/messages',
      headers: { 'x-term2-assertion': 'token', 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(unsupported.status).toBe(415);
    await server.close();
  });
});
