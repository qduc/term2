import { describe, expect, it, vi, beforeEach } from 'vitest';
import EventEmitter from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';

let spawnImplementation: ((command: string, args: string[], options: any) => any) | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: any) => {
      if (spawnImplementation) {
        return spawnImplementation(command, args, options);
      }
      return actual.spawn(command, args, options);
    },
  };
});

import { openInBrowser, runPkceLoopbackLogin, type PkceLoginConfig } from './oauth-pkce.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function pkceConfig(port: number): PkceLoginConfig {
  return {
    label: 'Codex',
    clientId: 'test-client',
    authorizeEndpoint: 'https://auth.example.test/authorize',
    tokenEndpoint: 'https://auth.example.test/token',
    redirectPorts: [port],
    redirectUriFor: (bound) => `http://localhost:${bound}/auth/callback`,
    callbackPath: '/auth/callback',
    scopes: ['openid'],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('openInBrowser', () => {
  beforeEach(() => {
    spawnImplementation = null;
  });

  it('does not throw or emit unhandled error when spawn fails asynchronously (e.g. xdg-open ENOENT)', async () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = vi.fn();

    let spawned = false;
    spawnImplementation = () => {
      spawned = true;
      process.nextTick(() => {
        const error = new Error('spawn xdg-open ENOENT') as any;
        error.code = 'ENOENT';
        fakeChild.emit('error', error);
      });
      return fakeChild;
    };

    expect(() => {
      openInBrowser('https://example.com/oauth/authorize');
    }).not.toThrow();

    expect(spawned).toBe(true);
    expect(fakeChild.unref).toHaveBeenCalled();

    // Wait a tick for the error event to fire
    await new Promise((resolve) => process.nextTick(resolve));
  });

  it('handles synchronous spawn throw gracefully', () => {
    spawnImplementation = () => {
      throw new Error('Sync spawn error');
    };

    expect(() => {
      openInBrowser('https://example.com/oauth/authorize');
    }).not.toThrow();
  });

  it('does not crash the process when the opener binary is missing from PATH', async () => {
    // Real spawn, not the EventEmitter stand-in: Node delivers ENOENT on
    // 'error' after spawn() returns, and a missing listener is a fatal throw.
    spawnImplementation = null;
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      expect(() => openInBrowser('https://example.com/oauth/authorize')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.env.PATH = previousPath;
    }
  });
});

describe('runPkceLoopbackLogin pasted redirect', () => {
  it('exchanges the code from a pasted loopback redirect URL', async () => {
    const port = await freePort();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'issued' }));
    const pasteInput = new PassThrough();
    let authorizeUrl = '';

    const login = runPkceLoopbackLogin(pkceConfig(port), {
      fetchImpl: fetchImpl as typeof fetch,
      openBrowser: () => {},
      pasteInput,
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    pasteInput.write(`  "http://127.0.0.1:${port}/auth/callback?code=pasted-code&state=${state}"  \n`);

    await expect(login).resolves.toMatchObject({ access_token: 'issued' });
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('code')).toBe('pasted-code');
  });

  it('ignores a non-callback paste and still accepts a later valid URL', async () => {
    const port = await freePort();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'issued' }));
    const pasteInput = new PassThrough();
    const rejected: string[] = [];
    let authorizeUrl = '';

    const login = runPkceLoopbackLogin(pkceConfig(port), {
      fetchImpl: fetchImpl as typeof fetch,
      openBrowser: () => {},
      pasteInput,
      onPasteRejected: (message) => {
        rejected.push(message);
      },
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    pasteInput.write(`${authorizeUrl}\n`);
    await vi.waitFor(() => expect(rejected.length).toBeGreaterThan(0));
    expect(rejected[0]).toMatch(/localhost/i);

    const state = new URL(authorizeUrl).searchParams.get('state')!;
    pasteInput.write(`http://localhost:${port}/auth/callback?code=second-try&state=${state}\n`);

    await expect(login).resolves.toMatchObject({ access_token: 'issued' });
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('code')).toBe('second-try');
  });

  it('rejects a pasted callback whose state does not match', async () => {
    const port = await freePort();
    const pasteInput = new PassThrough();
    let authorizeUrl = '';
    const login = runPkceLoopbackLogin(pkceConfig(port), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      openBrowser: () => {},
      pasteInput,
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    pasteInput.write(`http://localhost:${port}/auth/callback?code=stolen&state=not-our-state\n`);

    await expect(login).rejects.toThrow(/state mismatch/);
  });

  it('still completes via HTTP when pasteInput is attached but unused', async () => {
    const port = await freePort();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'issued' }));
    const pasteInput = new PassThrough();
    let authorizeUrl = '';

    const login = runPkceLoopbackLogin(pkceConfig(port), {
      fetchImpl: fetchImpl as typeof fetch,
      openBrowser: () => {},
      pasteInput,
      onPrompt: (url) => {
        authorizeUrl = url;
      },
    });

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''));
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const callback = new URL(`http://127.0.0.1:${port}/auth/callback`);
    callback.searchParams.set('code', 'http-code');
    callback.searchParams.set('state', state);
    await fetch(callback);

    await expect(login).resolves.toMatchObject({ access_token: 'issued' });
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('code')).toBe('http-code');
  });
});
