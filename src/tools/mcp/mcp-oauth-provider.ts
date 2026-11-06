import crypto from 'node:crypto';
import {
  validateClientMetadataUrl,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { McpOAuthCredentialScope, McpOAuthStore } from './mcp-oauth-store.js';

/** The client name authorization servers (and the user) see in consent screens. */
const MCP_OAUTH_CLIENT_NAME = 'term2-mcp';

export type McpOAuthProviderOptions = {
  /** Credential storage, keyed by server URL and issuer. */
  store: McpOAuthStore;
  /** The MCP server URL from the config; the credential storage key. */
  serverUrl: string;
  /**
   * The loopback redirect URI. A thunk when the port is only known after the
   * listener is bound — the SDK reads `redirectUrl` before the redirect is
   * built, so the bound port must be in place by then.
   */
  redirectUrl: string | (() => string);
  /**
   * CIMD: an HTTPS URL the authorization server fetches client metadata from,
   * replacing dynamic client registration.
   */
  clientMetadataUrl?: string;
  /**
   * A pre-registered client id from config. When set, the SDK never attempts
   * dynamic registration, which is the only way to reach an authorization
   * server that offers neither DCR nor CIMD.
   */
  clientId?: string;
  /**
   * Receives the authorization URL. Opening a browser, prompting the user, or
   * refusing (non-interactive, project server) is the caller's policy; this
   * adapter only reports what the SDK asked for.
   */
  onAuthorizationRedirect: (authorizationUrl: URL) => void | Promise<void>;
  /** PKCE state factory, injectable for deterministic tests. */
  createState?: () => string;
};

function defaultState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function requireIssuer(
  ctx: OAuthClientInformationContext | undefined,
  stampedIssuer: string | undefined,
  method: string,
): string {
  const issuer = ctx?.issuer ?? stampedIssuer;
  if (!issuer) {
    // Guessing would risk filing one authorization server's credential under
    // another's. The SDK always passes a context when it saves.
    throw new Error(`McpOAuthProvider.${method} requires the authorization server issuer`);
  }
  return issuer;
}

/**
 * The `OAuthClientProvider` the MCP SDK's `auth()` drives, backed by
 * `McpOAuthStore`.
 *
 * Everything policy-shaped is injected: this class decides nothing about when a
 * login may start, which authorization server is acceptable, or how the user is
 * sent there. It persists what the SDK hands it and returns what the SDK asks
 * for, keyed by the server URL — never by the config entry's name, so renaming a
 * server in `.mcp.json` cannot reach another server's token.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** CIMD URL, when the server publishes one; `undefined` falls back to DCR. */
  readonly clientMetadataUrl?: string;

  private readonly options: McpOAuthProviderOptions;
  /** The state most recently handed to the SDK, for callback validation. */
  private pendingState?: string;

  constructor(options: McpOAuthProviderOptions) {
    validateClientMetadataUrl(options.clientMetadataUrl);
    this.options = options;
    this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get redirectUrl(): string {
    const { redirectUrl } = this.options;
    return typeof redirectUrl === 'function' ? redirectUrl() : redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: MCP_OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      // `refresh_token` is declared because term2 does refresh: the SDK only
      // appends the `offline_access` scope when the client metadata says so.
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /**
   * The `state` the SDK puts in the authorization URL, recorded so the loopback
   * listener can reject a callback that did not come from this request.
   */
  state(): string {
    this.pendingState = (this.options.createState ?? defaultState)();
    return this.pendingState;
  }

  get authorizationState(): string | undefined {
    return this.pendingState;
  }

  /**
   * With no issuer there is no way to tell an unregistered client from another
   * authorization server's, and the SDK's contract for that call is "undefined
   * means not registered" — never another server's credential.
   */
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const stored = ctx?.issuer
      ? this.options.store.getClientInformation(this.options.serverUrl, ctx.issuer)
      : undefined;
    if (stored) return stored;
    // A configured client id is not bound to an issuer the way a dynamically
    // registered one is: the user registered this app themselves, for this
    // server, so it is returned even when the SDK asks without a context.
    // Returning it here is what stops `auth()` from attempting registration.
    if (this.options.clientId) return { client_id: this.options.clientId };
    return undefined;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    // A configured client id is owned by config, not by the store; persisting a
    // copy would leave a stale credential behind if the user later changes it.
    if (this.options.clientId) return;
    const issuer = requireIssuer(ctx, clientInformation.issuer, 'saveClientInformation');
    this.options.store.saveClientInformation(this.options.serverUrl, issuer, clientInformation);
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.options.store.getTokens(this.options.serverUrl, ctx?.issuer);
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const issuer = requireIssuer(ctx, tokens.issuer, 'saveTokens');
    this.options.store.saveTokens(this.options.serverUrl, issuer, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.options.onAuthorizationRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.options.store.saveCodeVerifier(this.options.serverUrl, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = this.options.store.getCodeVerifier(this.options.serverUrl);
    if (!verifier) {
      throw new Error(
        `No PKCE code verifier is stored for ${this.options.serverUrl}; the authorization flow must save one before the token exchange`,
      );
    }
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.options.store.saveDiscoveryState(this.options.serverUrl, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.options.store.getDiscoveryState(this.options.serverUrl);
  }

  invalidateCredentials(scope: McpOAuthCredentialScope): void {
    this.options.store.invalidateCredentials(this.options.serverUrl, scope);
  }
}
