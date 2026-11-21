// Shared pieces for the OAuth login tests (`term2 --codex-login`, `term2 --grok-login`).
//
// The login endpoints are constants in the product (`https://auth.openai.com`, `https://auth.x.ai`)
// with no environment or settings override, and the Codex callback uses fixed ports. So the built CLI
// is run unmodified and only the network boundary is redirected: a `--import` preload rewrites a
// `fetch` to those two hosts onto a loopback authorization server (the way a hosts-file entry would),
// and says which URL was originally asked for in `x-term2-original-url`. A `xdg-open` / `open` shim
// on PATH stands in for the browser and records what the CLI asked it to open. Nothing leaves 127.0.0.1.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestChildEnv } from './terminal-e2e.js';

export type LoginProvider = 'codex' | 'grok';

export type AuthRequest = {
  method: string;
  path: string;
  /** The URL the CLI asked `fetch` for, before the preload moved it onto the loopback server. */
  originalUrl: string;
  contentType: string;
  /** The body parsed by the encoding the provider uses (JSON for Codex, form for Grok). */
  params: Record<string, string>;
};

export type AuthServer = {
  readonly origin: string;
  readonly requests: AuthRequest[];
  close(): Promise<void>;
};

export type TokenReply = (request: AuthRequest, response: ServerResponse) => void;

const PRELOAD = `
const origin = process.env.TERM2_TEST_AUTH_ORIGIN;
const hosts = new Set((process.env.TERM2_TEST_REDIRECT_HOSTS || 'auth.openai.com,auth.x.ai').split(','));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw);
  if (!hosts.has(url.hostname)) return realFetch(input, init);
  const headers = new Headers(init && init.headers);
  headers.set('x-term2-original-url', raw);
  return realFetch(origin + url.pathname + url.search, { ...init, headers });
};
`;

/**
 * Environment for a child that must reach `hosts` (default: the two login hosts) on a loopback server
 * at `origin` instead. Writes the preload under `dir`.
 */
export function redirectHostsEnv(dir: string, origin: string, hosts?: string[]): NodeJS.ProcessEnv {
  const preload = path.join(dir, 'redirect-hosts.mjs');
  fs.writeFileSync(preload, PRELOAD);
  return {
    TERM2_TEST_AUTH_ORIGIN: origin,
    ...(hosts ? { TERM2_TEST_REDIRECT_HOSTS: hosts.join(',') } : {}),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
}

/** Unmistakably fake JWT: header `{}`, the given claims, and a literal placeholder signature. */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-signature`;
}

export function base64urlSha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

export const FAKE_ACCOUNT = { sub: 'fixture-user-1', email: 'fixture@example.test' };

/** What the authorization server answers by default: a complete, plausible token response. */
export function successfulTokenBody(): Record<string, unknown> {
  return {
    access_token: fakeJwt({ ...FAKE_ACCOUNT, exp: 4_000_000_000 }),
    refresh_token: 'fixture-refresh-token',
    id_token: fakeJwt(FAKE_ACCOUNT),
    expires_in: 3600,
    token_type: 'Bearer',
  };
}

export async function startAuthServer(reply?: TokenReply): Promise<AuthServer> {
  const requests: AuthRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const contentType = String(request.headers['content-type'] ?? '');
    let params: Record<string, string> = {};
    try {
      params = contentType.includes('json')
        ? (JSON.parse(text) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(text));
    } catch {
      params = { unparsed: text };
    }
    const captured: AuthRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      originalUrl: String(request.headers['x-term2-original-url'] ?? ''),
      contentType,
      params,
    };
    requests.push(captured);
    if (reply) {
      reply(captured, response);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify(successfulTokenBody()));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Authorization server fixture did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export type LoginSandbox = {
  root: string;
  home: string;
  configDir: string;
  /** Lines the browser shim recorded: the URLs the CLI asked the system to open. */
  openedUrls(): string[];
  env(authOrigin: string): NodeJS.ProcessEnv;
  cleanup(): void;
};

/** A throwaway HOME, XDG tree, config directory and temp directory, plus the preload and browser shim. */
export function createLoginSandbox(): LoginSandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-oauth-login-')));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const binDir = path.join(root, 'bin');
  const scratch = path.join(root, 'scratch');
  const openedFile = path.join(root, 'opened-urls.txt');
  for (const dir of [home, binDir, scratch, path.join(root, 'state'), path.join(root, 'data')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const name of ['xdg-open', 'open']) {
    const shim = path.join(binDir, name);
    fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${openedFile}'\n`);
    fs.chmodSync(shim, 0o755);
  }
  return {
    root,
    home,
    configDir,
    openedUrls: () =>
      fs.existsSync(openedFile) ? fs.readFileSync(openedFile, 'utf8').split('\n').filter(Boolean) : [],
    env: (authOrigin) =>
      createTestChildEnv({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: home,
        XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
        XDG_STATE_HOME: path.join(root, 'state'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        TERM2_CONFIG_DIR: configDir,
        TERM2_CACHE_DIR: path.join(root, 'cache'),
        TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
        DISABLE_LOGGING: '1',
        TMPDIR: scratch,
        TEMP: scratch,
        TMP: scratch,
        // A real credential path in the developer's own environment must not be consulted.
        CODEX_HOME: path.join(root, 'no-codex-home'),
        CHATGPT_LOCAL_HOME: path.join(root, 'no-chatgpt-home'),
        GROK_HOME: path.join(root, 'no-grok-home'),
        ...redirectHostsEnv(root, authOrigin),
      }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** What `runPkceLoopbackLogin` puts on the authorization URL, read back as the browser would see it. */
export type AuthorizeUrl = {
  url: URL;
  param(name: string): string;
  /** The loopback URL the authorization server would redirect the browser to, on the literal loopback IP. */
  callback(params: Record<string, string>): string;
};

export function parseAuthorizeUrl(raw: string): AuthorizeUrl {
  const url = new URL(raw);
  const param = (name: string): string => {
    const value = url.searchParams.get(name);
    if (value === null) throw new Error(`The authorization URL has no ${name}: ${raw}`);
    return value;
  };
  return {
    url,
    param,
    callback: (params) => {
      const target = new URL(param('redirect_uri'));
      // The authorization URL names `localhost` for Codex; the CLI listens on 127.0.0.1 only.
      target.hostname = '127.0.0.1';
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      return target.toString();
    },
  };
}

/** The authorization URL the CLI prints under "visit:", and nowhere else on the line. */
export function authorizeUrlFromOutput(output: string): string | null {
  return /If it does not open, visit:\s*\n(\S+)\n/.exec(output)?.[1] ?? null;
}

export const LOGIN_PROVIDERS = {
  codex: {
    flag: '--codex-login',
    label: 'Codex',
    credentialFile: 'codex-auth.json',
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    tokenPath: '/oauth/token',
    tokenContentType: 'application/x-www-form-urlencoded',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    retryCommand: 'term2 --codex-login',
  },
  grok: {
    flag: '--grok-login',
    label: 'Grok',
    credentialFile: 'grok-auth.json',
    authorize: 'https://auth.x.ai/oauth2/authorize',
    token: 'https://auth.x.ai/oauth2/token',
    tokenPath: '/oauth2/token',
    tokenContentType: 'application/x-www-form-urlencoded',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    retryCommand: 'term2 --grok-login',
  },
} as const satisfies Record<LoginProvider, Record<string, string>>;
