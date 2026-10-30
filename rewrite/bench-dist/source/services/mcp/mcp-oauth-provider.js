import crypto from 'node:crypto';
import { validateClientMetadataUrl, } from '@modelcontextprotocol/client';
/** The client name authorization servers (and the user) see in consent screens. */
const MCP_OAUTH_CLIENT_NAME = 'term2-mcp';
function defaultState() {
    return crypto.randomBytes(16).toString('base64url');
}
function requireIssuer(ctx, stampedIssuer, method) {
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
export class McpOAuthProvider {
    /** CIMD URL, when the server publishes one; `undefined` falls back to DCR. */
    clientMetadataUrl;
    options;
    /** The state most recently handed to the SDK, for callback validation. */
    pendingState;
    constructor(options) {
        validateClientMetadataUrl(options.clientMetadataUrl);
        this.options = options;
        this.clientMetadataUrl = options.clientMetadataUrl;
    }
    get redirectUrl() {
        const { redirectUrl } = this.options;
        return typeof redirectUrl === 'function' ? redirectUrl() : redirectUrl;
    }
    get clientMetadata() {
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
    state() {
        this.pendingState = (this.options.createState ?? defaultState)();
        return this.pendingState;
    }
    get authorizationState() {
        return this.pendingState;
    }
    /**
     * With no issuer there is no way to tell an unregistered client from another
     * authorization server's, and the SDK's contract for that call is "undefined
     * means not registered" — never another server's credential.
     */
    clientInformation(ctx) {
        const stored = ctx?.issuer
            ? this.options.store.getClientInformation(this.options.serverUrl, ctx.issuer)
            : undefined;
        if (stored)
            return stored;
        // A configured client id is not bound to an issuer the way a dynamically
        // registered one is: the user registered this app themselves, for this
        // server, so it is returned even when the SDK asks without a context.
        // Returning it here is what stops `auth()` from attempting registration.
        if (this.options.clientId)
            return { client_id: this.options.clientId };
        return undefined;
    }
    saveClientInformation(clientInformation, ctx) {
        // A configured client id is owned by config, not by the store; persisting a
        // copy would leave a stale credential behind if the user later changes it.
        if (this.options.clientId)
            return;
        const issuer = requireIssuer(ctx, clientInformation.issuer, 'saveClientInformation');
        this.options.store.saveClientInformation(this.options.serverUrl, issuer, clientInformation);
    }
    tokens(ctx) {
        return this.options.store.getTokens(this.options.serverUrl, ctx?.issuer);
    }
    saveTokens(tokens, ctx) {
        const issuer = requireIssuer(ctx, tokens.issuer, 'saveTokens');
        this.options.store.saveTokens(this.options.serverUrl, issuer, tokens);
    }
    redirectToAuthorization(authorizationUrl) {
        return this.options.onAuthorizationRedirect(authorizationUrl);
    }
    saveCodeVerifier(codeVerifier) {
        this.options.store.saveCodeVerifier(this.options.serverUrl, codeVerifier);
    }
    codeVerifier() {
        const verifier = this.options.store.getCodeVerifier(this.options.serverUrl);
        if (!verifier) {
            throw new Error(`No PKCE code verifier is stored for ${this.options.serverUrl}; the authorization flow must save one before the token exchange`);
        }
        return verifier;
    }
    saveDiscoveryState(state) {
        this.options.store.saveDiscoveryState(this.options.serverUrl, state);
    }
    discoveryState() {
        return this.options.store.getDiscoveryState(this.options.serverUrl);
    }
    invalidateCredentials(scope) {
        this.options.store.invalidateCredentials(this.options.serverUrl, scope);
    }
}
//# sourceMappingURL=mcp-oauth-provider.js.map