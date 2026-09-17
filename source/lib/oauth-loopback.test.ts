import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitLoopbackCallback,
  bindLoopbackRedirect,
  closeLoopbackServer,
  type BoundLoopbackRedirect,
  type LoopbackFlowConfig,
} from './oauth-loopback.js';

const open: BoundLoopbackRedirect[] = [];

afterEach(() => {
  for (const bound of open.splice(0)) closeLoopbackServer(bound.server);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function flowConfig(redirectUri: string, callbackPath = '/callback'): LoopbackFlowConfig {
  return { label: 'Test client', callbackPath, redirectUri, exampleCallbackUrl: `${redirectUri}?code=...` };
}

async function callback(origin: string, query: string, path = '/callback'): Promise<Response> {
  return fetch(`${origin}${path}?${query}`);
}

describe('bindLoopbackRedirect', () => {
  it('binds an ephemeral port on 127.0.0.1 by default', async () => {
    const bound = await bindLoopbackRedirect({ label: 'Test client' });
    open.push(bound);

    expect(bound.port).toBeGreaterThan(0);
    expect(bound.server.address()).toMatchObject({ address: '127.0.0.1', port: bound.port });
  });

  it('prefers the first free port from the preferred list', async () => {
    const busy = await freePort();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(busy, '127.0.0.1', () => resolve()));
    try {
      const free = await freePort();

      const bound = await bindLoopbackRedirect({ ports: [busy, free], label: 'Test client' });
      open.push(bound);

      expect(bound.port).toBe(free);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('names the client when every preferred port is taken', async () => {
    const busy = await freePort();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(busy, '127.0.0.1', () => resolve()));
    try {
      await expect(
        bindLoopbackRedirect({ ports: [busy], label: 'Test client', portConflictHint: 'another login' }),
      ).rejects.toThrow(/Test client login could not bind any of its registered redirect ports \(\d+\).*another login/);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe('awaitLoopbackCallback', () => {
  it('captures the authorization code from a callback with a matching state', async () => {
    const bound = await bindLoopbackRedirect({ label: 'Test client' });
    const origin = `http://127.0.0.1:${bound.port}`;
    const redirectUri = `${origin}/callback`;
    const pending = awaitLoopbackCallback(bound.server, flowConfig(redirectUri), 'state-1');

    const response = await callback(origin, 'code=abc&state=state-1');

    expect(response.status).toBe(200);
    await expect(pending).resolves.toBe('abc');
  });

  it('rejects a callback whose state does not match the request we started', async () => {
    const bound = await bindLoopbackRedirect({ label: 'Test client' });
    const origin = `http://127.0.0.1:${bound.port}`;
    const redirectUri = `${origin}/callback`;
    const pending = awaitLoopbackCallback(bound.server, flowConfig(redirectUri), 'state-1');
    // Attach the rejection assertion before the request arrives: a rejection
    // with no handler yet is reported as an unhandled error.
    const rejection = expect(pending).rejects.toThrow(/state mismatch/);

    await callback(origin, 'code=stolen&state=other');

    await rejection;
  });

  it('keeps waiting when a request hits a path other than the callback', async () => {
    const bound = await bindLoopbackRedirect({ label: 'Test client' });
    const origin = `http://127.0.0.1:${bound.port}`;
    const redirectUri = `${origin}/callback`;
    const pending = awaitLoopbackCallback(bound.server, flowConfig(redirectUri), 'state-1');

    const other = await callback(origin, 'code=abc&state=state-1', '/not-the-callback');
    expect(other.status).toBe(404);

    await callback(origin, 'code=abc&state=state-1');
    await expect(pending).resolves.toBe('abc');
  });

  it('stops waiting when the caller aborts', async () => {
    const bound = await bindLoopbackRedirect({ label: 'Test client' });
    const origin = `http://127.0.0.1:${bound.port}`;
    const redirectUri = `${origin}/callback`;
    const controller = new AbortController();
    const pending = awaitLoopbackCallback(bound.server, flowConfig(redirectUri), 'state-1', {
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
