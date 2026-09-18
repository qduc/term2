/**
 * The interactive half of MCP OAuth: bind a loopback redirect, drive the SDK's
 * `auth()` through both legs, and persist the result via {@linkcode McpOAuthProvider}.
 *
 * This module owns the *mechanics* of a login, never the *policy* of when one
 * may start. Plan decision D1 (2026-09-18) puts the trigger behind an explicit
 * `/mcp-login <server>`: nothing here runs on its own, so a server returning 401
 * mid-session can never pop a browser window. The connection manager only ever
 * refreshes silently (see {@linkcode McpInteractiveLoginRequiredError}).
 *
 * Redirect ports follow D3: an ephemeral port first (RFC 8252), falling back to
 * the server's configured `redirectPorts` for authorization servers that match
 * the redirect against a registered allow-list.
 */
import { auth as sdkAuth, type AuthResult } from '@modelcontextprotocol/client';
import {
  awaitLoopbackCallback,
  bindLoopbackRedirect,
  closeLoopbackServer,
  openInBrowser,
  type LoopbackFlowConfig,
} from '../../lib/oauth-loopback.js';
import { McpOAuthProvider } from './mcp-oauth-provider.js';
import { McpOAuthStore } from './mcp-oauth-store.js';

const CALLBACK_PATH = '/mcp-oauth-callback';

/**
 * Thrown by a refresh-only provider when the SDK concludes the user must visit
 * an authorization server. The connection manager turns this into the
 * `needs-auth` state rather than a browser window.
 */
export class McpInteractiveLoginRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" requires an interactive OAuth login`);
    this.name = 'McpInteractiveLoginRequiredError';
  }
}

/** The exact text a user acts on when a server is waiting for a login. */
export const mcpNeedsAuthMessage = (serverName: string): string =>
  `requires OAuth login — run /mcp-login ${serverName}`;

export interface McpOAuthLoginOptions {
  /** Config key of the server, used only in user-facing text. */
  serverName: string;
  /** The MCP server URL; the credential storage key. */
  serverUrl: string;
  store: McpOAuthStore;
  /** CIMD document URL, when the server config names one. Skips DCR. */
  clientMetadataUrl?: string;
  /**
   * Registered redirect ports to fall back to when the ephemeral port is not
   * acceptable to the authorization server (D3). Tried in order after port 0.
   */
  redirectPorts?: readonly number[];
  signal?: AbortSignal;
  /** Receives the authorization URL so the caller can show it (headless hosts). */
  onAuthorizationUrl?: (url: string) => void;
  /** Injectable for tests; defaults to really launching a browser. */
  openBrowser?: (url: string) => void;
  /** Injectable for tests; defaults to the SDK's `auth()`. */
  auth?: typeof sdkAuth;
}

export interface McpOAuthLoginResult {
  /** True when a browser round trip happened; false when a refresh sufficed. */
  readonly interactive: boolean;
  /** The issuer the credential was filed under, when the SDK reported one. */
  readonly issuer?: string;
}

/**
 * Runs a full OAuth login for one MCP server and stores the tokens.
 *
 * Resolves without opening a browser when the stored refresh token still works,
 * so re-running `/mcp-login` on a healthy server is cheap and safe.
 */
export async function runMcpOAuthLogin(options: McpOAuthLoginOptions): Promise<McpOAuthLoginResult> {
  const auth = options.auth ?? sdkAuth;
  const open = options.openBrowser ?? openInBrowser;
  // Port 0 first (RFC 8252); the configured list only exists so a server that
  // pins its redirect URI still works, not to find a free port.
  const ports = [0, ...(options.redirectPorts ?? [])];
  const { server, port } = await bindLoopbackRedirect({
    ports,
    label: `MCP server "${options.serverName}"`,
    portConflictHint: 'another login may be in progress',
  });
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const flow: LoopbackFlowConfig = {
    label: `MCP server "${options.serverName}"`,
    callbackPath: CALLBACK_PATH,
    redirectUri,
    exampleCallbackUrl: `${redirectUri}?code=...&state=...`,
  };

  let authorizationUrl: URL | undefined;
  const provider = new McpOAuthProvider({
    store: options.store,
    serverUrl: options.serverUrl,
    redirectUrl: redirectUri,
    ...(options.clientMetadataUrl !== undefined ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    onAuthorizationRedirect: (url) => {
      authorizationUrl = url;
    },
  });

  try {
    const first: AuthResult = await auth(provider, { serverUrl: options.serverUrl });
    if (first === 'AUTHORIZED') {
      // A stored refresh token still works; no browser round trip needed.
      return { interactive: false, ...issuerOf(provider) };
    }
    if (authorizationUrl === undefined) {
      throw new Error(`OAuth login for "${options.serverName}" produced no authorization URL`);
    }
    options.onAuthorizationUrl?.(authorizationUrl.toString());
    open(authorizationUrl.toString());

    // `state` is bound by the provider when the SDK built the URL; the listener
    // rejects any callback that does not carry it back.
    const expectedState = provider.authorizationState;
    if (expectedState === undefined) {
      throw new Error(`OAuth login for "${options.serverName}" started without a state parameter`);
    }
    const code = await awaitLoopbackCallback(server, flow, expectedState, {
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const second = await auth(provider, { serverUrl: options.serverUrl, authorizationCode: code });
    if (second !== 'AUTHORIZED') {
      throw new Error(`OAuth login for "${options.serverName}" ended in state ${second} instead of AUTHORIZED`);
    }
    return { interactive: true, ...issuerOf(provider) };
  } finally {
    // The browser holds a keep-alive socket on the callback port; without this
    // the next login on a configured (non-ephemeral) port would fail to bind.
    closeLoopbackServer(server);
  }
}

const issuerOf = (provider: McpOAuthProvider): { issuer?: string } => {
  const issuer = provider.tokens()?.issuer;
  return issuer !== undefined ? { issuer } : {};
};

/**
 * A provider that persists and refreshes but refuses to send the user anywhere.
 *
 * Handed to HTTP transports so an expired access token is renewed silently
 * mid-session, while a genuinely unauthenticated server surfaces as `needs-auth`
 * instead of hijacking the terminal with a browser launch.
 */
export function createRefreshOnlyProvider(options: {
  serverName: string;
  serverUrl: string;
  store: McpOAuthStore;
  clientMetadataUrl?: string;
}): McpOAuthProvider {
  return new McpOAuthProvider({
    store: options.store,
    serverUrl: options.serverUrl,
    // No listener is bound on this path. The value is only read when the SDK
    // builds an authorization URL, which the throw below always preempts.
    redirectUrl: `http://127.0.0.1:0${CALLBACK_PATH}`,
    ...(options.clientMetadataUrl !== undefined ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    onAuthorizationRedirect: () => {
      throw new McpInteractiveLoginRequiredError(options.serverName);
    },
  });
}
