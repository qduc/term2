import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from './server.js';
import { GatewayLifecycle } from './lifecycle.js';
import type { GatewayAssertionClaims } from './contracts.js';
import type { AssertionVerifier } from './assertion.js';
import { GatewayPairing, PairingError } from './pairing.js';
import { TrustedClientsStore } from './trusted-clients.js';

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

function makeTlsMaterial(root: string): {
  caPath: string;
  certPath: string;
  keyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
} {
  const caKeyPath = path.join(root, 'ca.key');
  const caPath = path.join(root, 'ca.crt');
  const serverKeyPath = path.join(root, 'server.key');
  const serverCsrPath = path.join(root, 'server.csr');
  const certPath = path.join(root, 'server.crt');
  const clientKeyPath = path.join(root, 'client.key');
  const clientCsrPath = path.join(root, 'client.csr');
  const clientCertPath = path.join(root, 'client.crt');
  const serverExtPath = path.join(root, 'server.ext');
  const clientExtPath = path.join(root, 'client.ext');
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  writeFileSync(serverExtPath, '[v3_req]\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  writeFileSync(clientExtPath, '[v3_req]\nextendedKeyUsage=clientAuth\n');
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKeyPath,
    '-out',
    caPath,
    '-subj',
    '/CN=term2-test-ca',
    '-days',
    '1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    serverKeyPath,
    '-out',
    serverCsrPath,
    '-subj',
    '/CN=127.0.0.1',
  ]);
  run([
    'x509',
    '-req',
    '-in',
    serverCsrPath,
    '-CA',
    caPath,
    '-CAkey',
    caKeyPath,
    '-CAcreateserial',
    '-out',
    certPath,
    '-days',
    '1',
    '-sha256',
    '-extfile',
    serverExtPath,
    '-extensions',
    'v3_req',
  ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    clientKeyPath,
    '-out',
    clientCsrPath,
    '-subj',
    '/CN=term2-test-client',
  ]);
  run([
    'x509',
    '-req',
    '-in',
    clientCsrPath,
    '-CA',
    caPath,
    '-CAkey',
    caKeyPath,
    '-CAcreateserial',
    '-out',
    clientCertPath,
    '-days',
    '1',
    '-sha256',
    '-extfile',
    clientExtPath,
    '-extensions',
    'v3_req',
  ]);
  return { caPath, certPath, keyPath: serverKeyPath, clientCertPath, clientKeyPath };
}

function secureCall(
  port: number,
  tls: { caPath: string; certPath?: string; keyPath?: string },
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        ca: readFileSync(tls.caPath),
        ...(tls.certPath && tls.keyPath ? { cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) } : {}),
        rejectUnauthorized: true,
        headers,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

describe('GatewayServer private socket transport', () => {
  it('verifies before routing, supports GET, POST, PUT, and DELETE, and passes the parsed URL', async () => {
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
    // DELETE must pass the method gate so credential_delete / oauth_delete
    // routes (which are matched on DELETE) can be reached.
    const del = await call(path.join(root, 'gateway.sock'), {
      method: 'DELETE',
      path: '/private/agent/v1/credentials/openai',
      headers: { 'x-term2-assertion': 'token' },
    });
    const unsupported = await call(path.join(root, 'gateway.sock'), {
      method: 'PATCH',
      path: '/private/agent/v1/settings',
      headers: { 'x-term2-assertion': 'token' },
    });
    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(del.status).toBe(200);
    expect(unsupported.status).toBe(405);
    expect(seen).toEqual([
      { method: 'GET', pathname: '/private/agent/v1/sessions', body: null, correlationId: 'corr-123' },
      { method: 'POST', pathname: '/private/agent/v1/sessions/s1/messages', body: { text: 'hi' } },
      { method: 'DELETE', pathname: '/private/agent/v1/credentials/openai', body: null },
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

describe('GatewayServer TLS network transport', () => {
  it('requires a client certificate and still verifies the gateway assertion', async () => {
    const root = makeRoot();
    const tls = makeTlsMaterial(root);
    const server = new GatewayServer({
      host: '127.0.0.1',
      port: 0,
      tls: { certPath: tls.certPath, keyPath: tls.keyPath, caPath: tls.caPath, requireClientCert: true },
      verifier: {
        verify: (token: string) => {
          if (token !== 'valid') throw new Error('invalid assertion');
          return claims;
        },
      } as unknown as AssertionVerifier,
      handler: async () => ({ status: 200, body: { ok: true } }),
    });
    await server.start();
    const port = (server.address as { port: number }).port;
    try {
      await expect(secureCall(port, { caPath: tls.caPath })).rejects.toBeDefined();
      await expect(
        secureCall(port, { caPath: tls.caPath, certPath: tls.clientCertPath, keyPath: tls.clientKeyPath }),
      ).resolves.toBe(401);
      await expect(
        secureCall(
          port,
          { caPath: tls.caPath, certPath: tls.clientCertPath, keyPath: tls.clientKeyPath },
          { 'x-term2-assertion': 'invalid' },
        ),
      ).resolves.toBe(401);
      await expect(
        secureCall(
          port,
          { caPath: tls.caPath, certPath: tls.clientCertPath, keyPath: tls.clientKeyPath },
          { 'x-term2-assertion': 'valid' },
        ),
      ).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('GatewayServer pairing bootstrap route', () => {
  it('accepts OTP-only registration before assertion authentication and rejects reuse', async () => {
    const root = makeRoot();
    const printed: string[] = [];
    const store = new TrustedClientsStore(path.join(root, 'trusted.json'));
    const pairing = new GatewayPairing({ enabled: true, trustStore: store, printOtp: (otp) => printed.push(otp) });
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const server = new GatewayServer({
      socketPath: path.join(root, 'gateway.sock'),
      verifier: {
        verify: () => {
          throw new Error('assertion must not be consulted');
        },
      } as unknown as AssertionVerifier,
      pairingHandler: async ({ body }) => {
        const value = body as { publicKeyPem?: string; otp?: string };
        try {
          const result = await pairing.register(value.publicKeyPem!, value.otp!);
          return { status: 200, body: result };
        } catch (error) {
          if (error instanceof PairingError) return { status: 401, body: { error: { code: error.code } } };
          throw error;
        }
      },
      handler: async () => ({ status: 500, body: null }),
    });
    await server.start();
    try {
      const first = await call(path.join(root, 'gateway.sock'), {
        method: 'POST',
        path: '/private/agent/v1/pairing/register',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyPem, otp: printed[0] }),
      });
      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toMatchObject({ paired: true, fingerprint: expect.any(String) });
      const reused = await call(path.join(root, 'gateway.sock'), {
        method: 'POST',
        path: '/private/agent/v1/pairing/register',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyPem, otp: printed[0] }),
      });
      expect(reused.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
