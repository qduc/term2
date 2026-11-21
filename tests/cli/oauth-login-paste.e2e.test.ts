// `term2 --grok-login` on a host whose browser cannot reach the CLI's loopback port (an SSH session, a
// container): with a terminal on stdin the login also accepts the redirected URL, or the bare code,
// typed into the terminal. That branch exists only when stdin is a TTY, so it is driven through a PTY.
// The browser, the authorization server and the endpoint redirection are the ones in
// tests/helpers/oauth-login-fixture.ts; the loopback-callback path is in oauth-login.integration.test.ts.
// Grok only: its loopback port is ephemeral, so this file cannot collide with Codex's fixed ports.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  authorizeUrlFromOutput,
  base64urlSha256,
  createLoginSandbox,
  parseAuthorizeUrl,
  startAuthServer,
  type AuthServer,
  type AuthorizeUrl,
  type LoginSandbox,
} from '../helpers/oauth-login-fixture.js';

const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));
const TIMEOUT = 60_000;

let sandbox: LoginSandbox;
let auth: AuthServer;
let session: TerminalSession | null = null;

beforeEach(async () => {
  sandbox = createLoginSandbox();
  auth = await startAuthServer();
});
afterEach(async () => {
  session?.dispose();
  session = null;
  await auth.close();
  sandbox.cleanup();
});

async function startGrokLogin(): Promise<{ terminal: TerminalSession; authorize: AuthorizeUrl }> {
  const terminal = spawnTerminal('node', [cli, '--grok-login'], {
    cwd: sandbox.root,
    env: sandbox.env(auth.origin),
    cols: 300,
  });
  session = terminal;
  await terminal.waitForOutput('paste it here');
  const url = authorizeUrlFromOutput(terminal.getVisibleOutput().replace(/\r/g, ''));
  if (!url) throw new Error(`No authorization URL in the terminal output:\n${terminal.getVisibleOutput()}`);
  return { terminal, authorize: parseAuthorizeUrl(url) };
}

const credentialFile = () => path.join(sandbox.configDir, 'grok-auth.json');
const NOT_A_CALLBACK = 'Paste the authorization code or the redirected localhost URL';

describe.skipIf(process.platform === 'win32')('Grok login with the redirect pasted into the terminal', () => {
  it(
    'ignores a line that is not a callback, then completes with the pasted redirected URL',
    { timeout: TIMEOUT },
    async () => {
      const { terminal, authorize } = await startGrokLogin();

      terminal.write('this is not a callback\r');
      await terminal.waitForOutput(NOT_A_CALLBACK);
      expect(auth.requests).toHaveLength(0);

      // What the browser's address bar shows after the redirect, copied back into the terminal.
      terminal.write(`${authorize.callback({ code: 'pasted-url-code', state: authorize.param('state') })}\r`);
      const exit = await terminal.waitForExit();
      expect(exit.exitCode, terminal.getVisibleOutput()).toBe(0);
      expect(terminal.getVisibleOutput()).toContain('Logged in to Grok as fixture@example.test.');

      expect(auth.requests).toHaveLength(1);
      const exchange = auth.requests[0]!.params;
      expect(exchange).toMatchObject({
        grant_type: 'authorization_code',
        code: 'pasted-url-code',
        redirect_uri: authorize.param('redirect_uri'),
      });
      expect(base64urlSha256(exchange.code_verifier!)).toBe(authorize.param('code_challenge'));
      const stored = JSON.parse(fs.readFileSync(credentialFile(), 'utf8'));
      expect(stored).toMatchObject({ version: 2, activeAccountId: 'fixture-user-1' });
      expect(fs.statSync(credentialFile()).mode & 0o777).toBe(0o600);
    },
  );

  it('accepts the bare authorization code alone', { timeout: TIMEOUT }, async () => {
    const { terminal } = await startGrokLogin();
    terminal.write('bare-code-from-address-bar\r');
    const exit = await terminal.waitForExit();
    expect(exit.exitCode, terminal.getVisibleOutput()).toBe(0);
    expect(auth.requests.map((request) => request.params.code)).toEqual(['bare-code-from-address-bar']);
    expect(fs.existsSync(credentialFile())).toBe(true);
  });

  it(
    'refuses a pasted redirect whose state is not the one it issued, before any token request',
    { timeout: TIMEOUT },
    async () => {
      const { terminal, authorize } = await startGrokLogin();
      terminal.write(`${authorize.callback({ code: 'forged-code', state: 'not-the-issued-state' })}\r`);
      const exit = await terminal.waitForExit();
      expect(exit.exitCode, terminal.getVisibleOutput()).toBe(1);
      expect(terminal.getVisibleOutput()).toContain('Grok login failed:');
      expect(terminal.getVisibleOutput()).toContain('OAuth state mismatch');
      expect(auth.requests).toHaveLength(0);
      expect(fs.existsSync(credentialFile())).toBe(false);
    },
  );
});
