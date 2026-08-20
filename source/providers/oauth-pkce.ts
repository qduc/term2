import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

/**
 * The browser half of an OAuth 2.0 + PKCE login for a public native client.
 *
 * Both providers term2 logs in to (Grok and Codex) borrow the official CLI's
 * registered client id, so the redirect URI is *their* registered value and is
 * not negotiable — see docs/plans/provider-oauth-independence.md. The only
 * thing that differs between them is endpoints, scopes, and how the token
 * endpoint wants its request body encoded, so all of that is configuration and
 * the flow itself lives here once.
 */
export type PkceLoginConfig = {
  /** Human-facing provider name, used in prompts and error messages. */
  label: string;
  clientId: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** The exact loopback redirect the authorization server has registered. */
  redirectUri: string;
  redirectPort: number;
  /** Path component of `redirectUri`; requests to anything else get a 404. */
  callbackPath: string;
  scopes: string[];
  /** Provider-specific authorize parameters beyond the standard PKCE set. */
  extraAuthorizeParams?: Record<string, string>;
  /** How the token endpoint wants the code exchange encoded. */
  tokenRequestEncoding?: 'form' | 'json';
  /** Appended to the EADDRINUSE message; names the likely conflicting process. */
  portConflictHint?: string;
};

export type PkceLoginOptions = {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => void;
  onPrompt?: (url: string) => void;
  signal?: AbortSignal;
};

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The caller always prints the URL, so a failed launcher is not fatal.
  }
}

function buildAuthorizeUrl(config: PkceLoginConfig, challenge: string, state: string): URL {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function awaitAuthorizationCode(config: PkceLoginConfig, options: PkceLoginOptions, authUrl: string): Promise<string> {
  const openBrowser = options.openBrowser || openInBrowser;
  const expectedState = new URL(authUrl).searchParams.get('state');

  return new Promise<string>((resolve, reject) => {
    // The callback is single-use. A retried or duplicated request after the
    // socket has been torn down must not run the handler a second time.
    let settled = false;
    const server = http.createServer((req, res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const requestUrl = new URL(req.url || '/', config.redirectUri);
      if (requestUrl.pathname !== config.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      settled = true;
      const error = requestUrl.searchParams.get('error');
      const received = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      const failure = error
        ? new Error(`${config.label} login was rejected: ${error}`)
        : state !== expectedState
        ? // A mismatched state means this callback did not come from the
          // authorization request we started; the code may be an attacker's.
          new Error(`${config.label} login failed: OAuth state mismatch`)
        : !received
        ? new Error(`${config.label} login failed: no authorization code in callback`)
        : null;

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(failure ? `${failure.message}\nYou can close this tab.` : 'Login complete. You can close this tab.');
      // Free the fixed callback port immediately: a keep-alive browser socket
      // would otherwise hold it and make the next login attempt fail.
      server.close();
      server.closeAllConnections?.();
      if (failure) reject(failure);
      else resolve(received!);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${config.redirectPort} is in use. ${
                config.label
              } only accepts that exact redirect, so close whatever holds it${
                config.portConflictHint ? ` (${config.portConflictHint})` : ''
              } and retry.`,
            )
          : err,
      );
    });

    options.signal?.addEventListener('abort', () => {
      server.close();
      reject(new Error(`${config.label} login cancelled`));
    });

    server.listen(config.redirectPort, '127.0.0.1', () => {
      options.onPrompt?.(authUrl);
      openBrowser(authUrl);
    });
  });
}

/**
 * Runs the full browser login and returns the token endpoint's raw response
 * body. Mapping that body into a provider's stored credential shape, and
 * persisting it, belongs to the caller.
 *
 * Resolves only after the authorization server redirects back to the loopback
 * listener, so callers should treat this as a long, human-paced operation.
 */
export async function runPkceLoopbackLogin(config: PkceLoginConfig, options: PkceLoginOptions = {}): Promise<any> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authUrl = buildAuthorizeUrl(config, challenge, state).toString();
  const code = await awaitAuthorizationCode(config, options, authUrl);

  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
    client_id: config.clientId,
  };
  const useJson = config.tokenRequestEncoding === 'json';
  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': useJson ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: useJson ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`${config.label} token exchange failed with status ${response.status}`);
  }
  const body = await response.json();
  if (!body?.access_token) {
    throw new Error(`${config.label} token exchange response did not contain access_token`);
  }
  return body;
}
