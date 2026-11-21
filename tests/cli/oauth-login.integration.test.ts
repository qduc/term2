// The browser logins: `term2 --codex-login` and `term2 --grok-login`, run as the built CLI.
//
// Token refresh and account pinning are covered in tests/model/oauth-*.integration.test.ts; this file
// covers the step before them, how a credential gets onto disk at all. The test plays the browser and the
// authorization server on loopback (see tests/helpers/oauth-login-fixture.ts for how the product's fixed
// https://auth.openai.com and https://auth.x.ai endpoints are redirected without touching src/). The
// pasted-redirect entry, which needs a terminal on stdin, is in oauth-login-paste.e2e.test.ts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrationCliPath as cliPath } from '../helpers/integration-cli.js';
import {
  LOGIN_PROVIDERS,
  authorizeUrlFromOutput,
  base64urlSha256,
  createLoginSandbox,
  parseAuthorizeUrl,
  startAuthServer,
  type AuthServer,
  type AuthorizeUrl,
  type LoginProvider,
  type LoginSandbox,
  type TokenReply,
} from '../helpers/oauth-login-fixture.js';

const TIMEOUT = 30_000;
const FAKE_CODE = 'fixture-authorization-code';
const providers = Object.keys(LOGIN_PROVIDERS) as LoginProvider[];

let sandbox: LoginSandbox;
let auth: AuthServer | undefined;
const held: net.Server[] = [];
const children: Array<{ kill(): void }> = [];

beforeEach(() => {
  sandbox = createLoginSandbox();
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of held.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await auth?.close();
  auth = undefined;
  sandbox.cleanup();
});

type Login = {
  /** Resolves with the URL printed for the user, or rejects if the CLI exits without printing one. */
  authorizeUrl(): Promise<AuthorizeUrl>;
  output(): { stdout: string; stderr: string };
  finished: Promise<{ status: number | null; stdout: string; stderr: string }>;
};

async function startLogin(provider: LoginProvider, reply?: TokenReply): Promise<Login> {
  auth = await startAuthServer(reply);
  const child = spawn('node', [cliPath(), LOGIN_PROVIDERS[provider].flag], {
    cwd: sandbox.root,
    env: sandbox.env(auth.origin),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT,
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const finished = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return {
    output: () => ({ stdout, stderr }),
    finished,
    authorizeUrl: () =>
      new Promise<AuthorizeUrl>((resolve, reject) => {
        const timer = setInterval(() => {
          const url = authorizeUrlFromOutput(stdout);
          if (url) {
            clearInterval(timer);
            resolve(parseAuthorizeUrl(url));
          }
        }, 20);
        void finished.then(() => {
          clearInterval(timer);
          const url = authorizeUrlFromOutput(stdout);
          if (url) resolve(parseAuthorizeUrl(url));
          else reject(new Error(`The login exited without printing a URL\nstdout=${stdout}\nstderr=${stderr}`));
        });
      }),
  };
}

/** The browser arriving back at the loopback redirect. */
async function visit(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

const credentialPath = (provider: LoginProvider) =>
  path.join(sandbox.configDir, LOGIN_PROVIDERS[provider].credentialFile);

/** Hold a loopback port the way a concurrent `codex login` would. */
async function occupy(port: number): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) =>
      reject(new Error(`Port ${port} is already in use on this machine, so the Codex port tests cannot run: ${error}`)),
    );
    server.listen(port, '127.0.0.1', resolve);
  });
  held.push(server);
}

/** What the login printed on stderr, one entry per non-empty line. */
const stderrLines = (run: { stderr: string }) => run.stderr.split('\n').filter((line) => line.trim() !== '');

const describeRun = (run: { status: number | null; stdout: string; stderr: string }) =>
  `exit=${run.status}\nstdout=${run.stdout}\nstderr=${run.stderr}`;

describe.skipIf(process.platform === 'win32')('browser login through the built CLI', () => {
  it.each(providers)(
    '%s: prints and opens a PKCE authorization URL, exchanges the code, and writes a private credential file',
    async (provider) => {
      const spec = LOGIN_PROVIDERS[provider];
      const login = await startLogin(provider);
      const authorize = await login.authorizeUrl();

      // The authorization request.
      expect(`${authorize.url.origin}${authorize.url.pathname}`).toBe(spec.authorize);
      expect(authorize.param('client_id')).toBe(spec.clientId);
      expect(authorize.param('response_type')).toBe('code');
      expect(authorize.param('code_challenge_method')).toBe('S256');
      const challenge = authorize.param('code_challenge');
      const state = authorize.param('state');
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state.length).toBeGreaterThanOrEqual(16);
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
      if (provider === 'codex') {
        expect(authorize.param('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        expect(authorize.param('scope')).toBe(
          'openid profile email offline_access api.connectors.read api.connectors.invoke',
        );
        expect(Object.fromEntries(authorize.url.searchParams)).toMatchObject({
          id_token_add_organizations: 'true',
          codex_cli_simplified_flow: 'true',
          originator: 'codex_cli_rs',
        });
      } else {
        expect(authorize.param('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        expect(authorize.param('scope')).toBe(
          'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
        );
      }

      // What the user was told, and what the system was asked to open.
      const printed = login.output().stdout;
      expect(printed).toContain(`Opening your browser to log in to ${spec.label}.`);
      expect(printed).toContain('paste it here');
      await expect.poll(() => sandbox.openedUrls(), { timeout: 5_000 }).toEqual([authorize.url.toString()]);

      // A stray request to the listener is refused and does not end the login.
      const stray = new URL(authorize.callback({}));
      stray.pathname = '/favicon.ico';
      stray.search = '';
      expect((await visit(stray.toString())).status).toBe(404);
      expect(auth!.requests).toHaveLength(0);

      // The browser comes back with the code and the state it was given.
      const callback = await visit(authorize.callback({ code: FAKE_CODE, state }));
      expect(callback.status).toBe(200);
      expect(callback.body).toContain('Login complete');
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(0);
      expect(run.stdout).toContain(
        provider === 'codex' ? 'Logged in to Codex.' : 'Logged in to Grok as fixture@example.test.',
      );

      // The token exchange: one POST to the provider's token endpoint, proving the same verifier.
      expect(auth!.requests).toHaveLength(1);
      const exchange = auth!.requests[0]!;
      expect(exchange.method).toBe('POST');
      expect(exchange.originalUrl).toBe(spec.token);
      expect(exchange.path).toBe(spec.tokenPath);
      expect(exchange.contentType).toBe(spec.tokenContentType);
      expect(exchange.params).toEqual({
        grant_type: 'authorization_code',
        code: FAKE_CODE,
        redirect_uri: authorize.param('redirect_uri'),
        code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/),
        client_id: spec.clientId,
      });
      expect(base64urlSha256(exchange.params.code_verifier!)).toBe(challenge);

      // The credential file: where, who can read it, and what is in it.
      expect(fs.readdirSync(sandbox.configDir)).toEqual([spec.credentialFile]);
      expect(fs.statSync(credentialPath(provider)).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(fs.readFileSync(credentialPath(provider), 'utf8'));
      const token = stored.accounts[0].tokens;
      expect(stored).toMatchObject({ version: 2, activeAccountId: 'fixture-user-1' });
      expect(stored.accounts).toHaveLength(1);
      expect(stored.accounts[0]).toMatchObject({ id: 'fixture-user-1', label: 'fixture@example.test' });
      expect(Number.isNaN(Date.parse(stored.accounts[0].addedAt))).toBe(false);
      expect(token).toMatchObject({
        access_token: expect.stringMatching(/^e30\..+\.fake-signature$/),
        refresh_token: 'fixture-refresh-token',
        id_token: expect.stringMatching(/^e30\..+\.fake-signature$/),
      });
      if (provider === 'grok') {
        // `expires_in` is relative; the file holds an absolute time.
        expect(token.expires_at).toBeGreaterThan(Date.now() + 3_500_000);
        expect(token.expires_at).toBeLessThan(Date.now() + 3_700_000);
        expect(token).toMatchObject({ email: 'fixture@example.test', user_id: 'fixture-user-1' });
      } else {
        expect(token.expires_at).toBeUndefined();
      }

      // Neither secret is echoed to the terminal, and nothing else was written under HOME.
      for (const secret of [token.access_token, token.refresh_token, exchange.params.code_verifier!]) {
        expect(run.stdout + run.stderr).not.toContain(secret);
      }
      expect(fs.readdirSync(sandbox.home)).toEqual([]);
    },
    TIMEOUT,
  );

  it.each(providers)(
    '%s: a callback whose state does not match is refused before any token request, and nothing is saved',
    async (provider) => {
      const spec = LOGIN_PROVIDERS[provider];
      const login = await startLogin(provider);
      const authorize = await login.authorizeUrl();
      const state = authorize.param('state');

      const callback = await visit(authorize.callback({ code: FAKE_CODE, state: `${state}-forged` }));
      expect(callback.body).toContain('OAuth state mismatch');
      expect(callback.body).not.toContain('Login complete');
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual([`${spec.label} login failed: OAuth state mismatch`]);
      expect(run.stdout).not.toContain('Logged in');
      expect(auth!.requests, 'a forged callback must not reach the token endpoint').toHaveLength(0);
      expect(fs.existsSync(credentialPath(provider))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'codex: an authorization-server rejection is reported with its reason and ends the login',
    async () => {
      const login = await startLogin('codex');
      const authorize = await login.authorizeUrl();
      await visit(authorize.callback({ error: 'access_denied', state: authorize.param('state') }));
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual(['Codex login was rejected: access_denied']);
      expect(auth!.requests).toHaveLength(0);
      expect(fs.existsSync(credentialPath('codex'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'grok: every login attempt generates its own state, verifier challenge and loopback port',
    async () => {
      const seen: Array<{ state: string; challenge: string; redirect: string }> = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const login = await startLogin('grok');
        const authorize = await login.authorizeUrl();
        seen.push({
          state: authorize.param('state'),
          challenge: authorize.param('code_challenge'),
          redirect: authorize.param('redirect_uri'),
        });
        await visit(authorize.callback({ error: 'access_denied', state: authorize.param('state') }));
        const run = await login.finished;
        expect(run.status, describeRun(run)).toBe(1);
        expect(stderrLines(run)).toEqual(['Grok login was rejected: access_denied']);
        await auth!.close();
        auth = undefined;
      }
      expect(seen[0]!.state).not.toBe(seen[1]!.state);
      expect(seen[0]!.challenge).not.toBe(seen[1]!.challenge);
    },
    TIMEOUT,
  );

  it.each(providers)(
    '%s: a token endpoint that refuses the code fails the login with the status and the retry command, saving nothing',
    async (provider) => {
      const spec = LOGIN_PROVIDERS[provider];
      const status = provider === 'codex' ? 400 : 500;
      const login = await startLogin(provider, (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: 'invalid_grant' }));
      });
      const authorize = await login.authorizeUrl();
      // The browser already saw "Login complete" by the time the exchange fails.
      const callback = await visit(authorize.callback({ code: FAKE_CODE, state: authorize.param('state') }));
      expect(callback.body).toContain('Login complete');
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual([
        `${spec.label} token exchange failed with status ${status} (the browser showed "Login complete" but the code could not be exchanged — retry ${spec.retryCommand})`,
      ]);
      expect(run.stdout).not.toContain('Logged in');
      expect(auth!.requests).toHaveLength(1);
      expect(fs.existsSync(credentialPath(provider))).toBe(false);
    },
    TIMEOUT,
  );

  it.each(providers)(
    '%s: a token endpoint that drops the connection fails the login with the provider label added once',
    async (provider) => {
      const spec = LOGIN_PROVIDERS[provider];
      const login = await startLogin(provider, (_request, response) => response.socket?.destroy());
      const authorize = await login.authorizeUrl();
      await visit(authorize.callback({ code: FAKE_CODE, state: authorize.param('state') }));
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual([`${spec.label} login failed: fetch failed`]);
      expect(fs.existsSync(credentialPath(provider))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'codex: a token response without an access token fails the login and saves nothing',
    async () => {
      const login = await startLogin('codex', (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ refresh_token: 'fixture-refresh-token', token_type: 'Bearer' }));
      });
      const authorize = await login.authorizeUrl();
      await visit(authorize.callback({ code: FAKE_CODE, state: authorize.param('state') }));
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual(['Codex token exchange response did not contain access_token']);
      expect(fs.existsSync(credentialPath('codex'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'codex: with its first registered port busy the login moves to the second and names it as the redirect',
    async () => {
      await occupy(1455);
      const login = await startLogin('codex');
      const authorize = await login.authorizeUrl();
      expect(authorize.param('redirect_uri')).toBe('http://localhost:1457/auth/callback');
      await visit(authorize.callback({ code: FAKE_CODE, state: authorize.param('state') }));
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(0);
      expect(auth!.requests[0]!.params.redirect_uri).toBe('http://localhost:1457/auth/callback');
      expect(fs.existsSync(credentialPath('codex'))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'codex: with both registered ports busy the login stops before showing a URL, naming the conflict',
    async () => {
      await occupy(1455);
      await occupy(1457);
      const login = await startLogin('codex');
      const run = await login.finished;
      expect(run.status, describeRun(run)).toBe(1);
      expect(stderrLines(run)).toEqual([
        expect.stringMatching(
          /^Codex login could not bind any of its registered redirect ports \(1455, 1457\)\..* and retry\.$/,
        ),
      ]);
      expect(run.stderr).toContain('codex login');
      expect(authorizeUrlFromOutput(run.stdout)).toBeNull();
      expect(sandbox.openedUrls()).toEqual([]);
      expect(auth!.requests).toHaveLength(0);
      expect(fs.existsSync(credentialPath('codex'))).toBe(false);
    },
    TIMEOUT,
  );
});
