import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  awaitLoopbackCallback,
  bindLoopbackRedirect,
  closeLoopbackServer,
  openInBrowser,
  type LoopbackFlowConfig,
} from '../lib/oauth-loopback.js';

/**
 * The browser half of an OAuth 2.0 + PKCE login for a public native client.
 *
 * Both providers term2 logs in to (Grok and Codex) borrow the official CLI's
 * registered client id, so the redirect URI is *their* registered value and is
 * not negotiable — see docs/plans/provider-oauth-independence.md. The only
 * thing that differs between them is endpoints, scopes, and how the token
 * endpoint wants its request body encoded, so all of that is configuration and
 * the flow itself lives here once.
 *
 * The loopback listener and callback handling live in `source/lib/oauth-loopback.ts`
 * so MCP OAuth (whose redirect port is chosen at runtime) can reuse them.
 */
export { openInBrowser };

export type PkceLoginConfig = {
  /** Human-facing provider name, used in prompts and error messages. */
  label: string;
  clientId: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /**
   * The loopback ports the authorization server has registered, in preference
   * order. Servers that match the redirect against an allow-list only accept
   * the ports the official client registered, so a fallback exists to survive a
   * concurrent CLI login, not to pick a free port. `[0]` binds an ephemeral
   * port, for servers that honour RFC 8252 loopback port flexibility.
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
  /**
   * Line-oriented source for a pasted loopback redirect URL, its query string,
   * or the bare code. Remote hosts never receive the browser's localhost
   * callback; the address bar still holds it.
   */
  pasteInput?: Readable;
  /** Called when a pasted line is not a usable callback, so the user can retry. */
  onPasteRejected?: (message: string) => void;
};

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

function exampleCallbackUrl(config: PkceLoginConfig): string {
  const port = config.redirectPorts[0];
  return `http://localhost:${port === 0 ? '<port>' : port}${config.callbackPath}?code=...`;
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
  const { server, port } = await bindLoopbackRedirect({
    ports: config.redirectPorts,
    label: config.label,
    portConflictHint: config.portConflictHint,
  });
  const redirectUri = config.redirectUriFor(port);
  const flowConfig: LoopbackFlowConfig = {
    label: config.label,
    callbackPath: config.callbackPath,
    redirectUri,
    exampleCallbackUrl: exampleCallbackUrl(config),
  };
  const authUrl = buildAuthorizeUrl(config, redirectUri, challenge, state).toString();

  const callback = awaitLoopbackCallback(server, flowConfig, state, {
    signal: options.signal,
    pasteInput: options.pasteInput,
    onPasteRejected: options.onPasteRejected,
  });

  options.onPrompt?.(authUrl);
  openBrowser(authUrl);

  let code: string;
  try {
    code = await callback;
  } catch (error) {
    closeLoopbackServer(server);
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
  // The browser already showed "Login complete" on the loopback callback, so
  // a later exchange failure must be explicit in the terminal — the code is
  // one-time and the user will need to retry the login.
  // Don't create a real timer in tests — fake timers make AbortSignal.timeout warn with NaN.
  const timeoutSignal =
    process.env.NODE_ENV === 'test'
      ? undefined
      : (AbortSignal as any).timeout
      ? (AbortSignal as any).timeout(30_000)
      : undefined;
  const fetchSignal = options.signal
    ? timeoutSignal && (AbortSignal as any).any
      ? (AbortSignal as any).any([options.signal, timeoutSignal])
      : options.signal
    : timeoutSignal;
  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': useJson ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: useJson ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    ...(fetchSignal ? { signal: fetchSignal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `${config.label} token exchange failed with status ${
        response.status
      } (the browser showed "Login complete" but the code could not be exchanged — retry ${
        config.label.toLowerCase() === 'grok' ? 'term2 --grok-login' : 'term2 --codex-login'
      })`,
    );
  }
  const body = await response.json();
  if (!body?.access_token) {
    throw new Error(`${config.label} token exchange response did not contain access_token`);
  }
  return body;
}
