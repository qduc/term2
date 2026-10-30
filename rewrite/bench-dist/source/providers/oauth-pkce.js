import crypto from 'node:crypto';
import { awaitLoopbackCallback, bindLoopbackRedirect, closeLoopbackServer, openInBrowser, } from '../lib/oauth-loopback.js';
/**
 * The browser half of an OAuth 2.0 + PKCE login for a public native client.
 *
 * Both providers term2 logs in to (Grok and Codex) borrow the official CLI's
 * registered client id, so the redirect URI is *their* registered value and is
 * not negotiable — see docs/plans/providers/provider-oauth-independence.md. The only
 * thing that differs between them is endpoints, scopes, and how the token
 * endpoint wants its request body encoded, so all of that is configuration and
 * the flow itself lives here once.
 *
 * The loopback listener and callback handling live in `source/lib/oauth-loopback.ts`
 * so MCP OAuth (whose redirect port is chosen at runtime) can reuse them.
 */
export { openInBrowser };
function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildAuthorizeUrl(config, redirectUri, challenge, state) {
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
function exampleCallbackUrl(config) {
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
export async function runPkceLoopbackLogin(config, options = {}) {
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
    const flowConfig = {
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
    let code;
    try {
        code = await callback;
    }
    catch (error) {
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
    const timeoutSignal = process.env.NODE_ENV === 'test'
        ? undefined
        : AbortSignal.timeout
            ? AbortSignal.timeout(30_000)
            : undefined;
    const fetchSignal = options.signal
        ? timeoutSignal && AbortSignal.any
            ? AbortSignal.any([options.signal, timeoutSignal])
            : options.signal
        : timeoutSignal;
    const response = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': useJson ? 'application/json' : 'application/x-www-form-urlencoded' },
        body: useJson ? JSON.stringify(params) : new URLSearchParams(params).toString(),
        ...(fetchSignal ? { signal: fetchSignal } : {}),
    });
    if (!response.ok) {
        throw new Error(`${config.label} token exchange failed with status ${response.status} (the browser showed "Login complete" but the code could not be exchanged — retry ${config.label.toLowerCase() === 'grok' ? 'term2 --grok-login' : 'term2 --codex-login'})`);
    }
    const body = await response.json();
    if (!body?.access_token) {
        throw new Error(`${config.label} token exchange response did not contain access_token`);
    }
    return body;
}
//# sourceMappingURL=oauth-pkce.js.map