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
  /**
   * The loopback ports the authorization server has registered, in preference
   * order. These servers match the redirect against an allow-list rather than
   * honouring RFC 8252 port flexibility, so we may only try ports the official
   * client registered — a fallback exists to survive a concurrent CLI login,
   * not to pick a free port.
   */
  redirectPorts: number[];
  /** Builds the redirect for whichever registered port we managed to bind. */
  redirectUriFor: (port: number) => string;
  /** Path component of the redirect; requests to anything else get a 404. */
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

function buildAuthorizeUrl(config: PkceLoginConfig, redirectUri: string, challenge: string, state: string): URL {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Binds the first registered loopback port that is free.
 *
 * We may only try ports the official client registered, so an exhausted list is
 * a real failure with a real cause: another login is almost certainly holding
 * the port.
 */
function bindLoopbackListener(config: PkceLoginConfig): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const attempt = (index: number) => {
      const port = config.redirectPorts[index];
      const server = http.createServer();
      const onError = (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }
        if (index + 1 < config.redirectPorts.length) {
          attempt(index + 1);
          return;
        }
        reject(
          new Error(
            `${config.label} login could not bind any of its registered redirect ports (${config.redirectPorts.join(
              ', ',
            )}). The authorization server only accepts those exact redirects, so close whatever holds them${
              config.portConflictHint ? ` (${config.portConflictHint})` : ''
            } and retry.`,
          ),
        );
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve({ server, port });
      });
    };
    attempt(0);
  });
}

function awaitCallback(
  config: PkceLoginConfig,
  server: http.Server,
  redirectUri: string,
  expectedState: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // The callback is single-use. A retried or duplicated request after the
    // socket has been torn down must not run the handler a second time.
    let settled = false;
    server.on('request', (req, res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const requestUrl = new URL(req.url || '/', redirectUri);
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
      // Free the callback port immediately: a keep-alive browser socket would
      // otherwise hold it and make the next login attempt fail.
      server.close();
      server.closeAllConnections?.();
      if (failure) reject(failure);
      else resolve(received!);
    });

    server.on('error', reject);
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
  const openBrowser = options.openBrowser || openInBrowser;

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  // Bind before building the URL: the redirect_uri we send must name the port
  // we actually got, or the authorization server will refuse the callback.
  const { server, port } = await bindLoopbackListener(config);
  const redirectUri = config.redirectUriFor(port);
  const authUrl = buildAuthorizeUrl(config, redirectUri, challenge, state).toString();

  const callback = awaitCallback(config, server, redirectUri, state);
  options.signal?.addEventListener('abort', () => {
    server.close();
    server.closeAllConnections?.();
  });

  options.onPrompt?.(authUrl);
  openBrowser(authUrl);

  let code: string;
  try {
    code = await (options.signal
      ? Promise.race([
          callback,
          new Promise<never>((_, reject) =>
            options.signal!.addEventListener('abort', () => reject(new Error(`${config.label} login cancelled`))),
          ),
        ])
      : callback);
  } catch (error) {
    server.close();
    server.closeAllConnections?.();
    throw error;
  }

  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
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
