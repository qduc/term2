import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
export function openInBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => {
            // Ignored: opening a browser in a headless/server/minimal environment or when
            // the browser launcher is missing (e.g. xdg-open ENOENT) is non-fatal.
            // The caller always prints the URL, so the user can complete login manually.
        });
        child.unref();
    }
    catch {
        // The caller always prints the URL, so a failed launcher is not fatal.
    }
}
/**
 * Binds the first free loopback port from the preference list.
 *
 * Always the literal `127.0.0.1`, never `localhost`: the hostname can resolve to
 * IPv6 or, on a misconfigured host, to something that is not loopback at all.
 */
export function bindLoopbackRedirect(options) {
    const ports = options.ports?.length ? options.ports : [0];
    return new Promise((resolve, reject) => {
        const attempt = (index) => {
            const port = ports[index];
            const server = http.createServer();
            const onError = (err) => {
                server.close();
                if (err.code !== 'EADDRINUSE') {
                    reject(err);
                    return;
                }
                if (index + 1 < ports.length) {
                    attempt(index + 1);
                    return;
                }
                const description = ports.length === 1 && ports[0] === 0
                    ? 'an ephemeral loopback port'
                    : `any of its registered redirect ports (${ports.join(', ')})`;
                reject(new Error(`${options.label} login could not bind ${description}. The authorization server only accepts those exact redirects, so close whatever holds them${options.portConflictHint ? ` (${options.portConflictHint})` : ''} and retry.`));
            };
            server.once('error', onError);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', onError);
                // Port 0 asks the OS for an ephemeral port; the redirect must name the real one.
                resolve({ server, port: server.address().port });
            });
        };
        attempt(0);
    });
}
/**
 * Frees the callback port immediately: a keep-alive browser socket would
 * otherwise hold it and make the next login attempt fail.
 */
export function closeLoopbackServer(server) {
    server.close();
    server.closeAllConnections?.();
}
function stripWrappingQuotes(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function isLoopbackHostname(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
export function interpretCallbackParams(config, expectedState, error, code, state) {
    if (error)
        return new Error(`${config.label} login was rejected: ${error}`);
    if (state !== expectedState) {
        // A mismatched state means this callback did not come from the
        // authorization request we started; the code may be an attacker's.
        return new Error(`${config.label} login failed: OAuth state mismatch`);
    }
    if (!code)
        return new Error(`${config.label} login failed: no authorization code in callback`);
    return code;
}
/** Characters an authorization code may contain, raw or percent-encoded. */
const BARE_CODE_PATTERN = /^[A-Za-z0-9._~+/=%-]+$/;
/**
 * Accepts the callback's query string (`code=...&state=...`) or the bare code.
 *
 * A bare code carries no state to check. That is acceptable here because the
 * user copied it from their own browser into this terminal; the state check
 * guards the loopback listener against codes injected by other pages.
 */
function interpretPastedCodeOrQuery(raw, config, expectedState) {
    const notUsable = {
        kind: 'ignore',
        message: `Paste the authorization code or the redirected localhost URL (${config.exampleCallbackUrl}).`,
    };
    if (/(^|[?&])(code|error)=/.test(raw)) {
        const params = new URLSearchParams(raw.replace(/^[?#]/, ''));
        const result = interpretCallbackParams(config, expectedState, params.get('error'), params.get('code'), params.get('state'));
        return result instanceof Error ? { kind: 'fail', error: result } : { kind: 'code', code: result };
    }
    if (!BARE_CODE_PATTERN.test(raw))
        return notUsable;
    try {
        return { kind: 'code', code: decodeURIComponent(raw) };
    }
    catch {
        return notUsable;
    }
}
function interpretPastedOAuthRedirect(line, config, expectedState) {
    const raw = stripWrappingQuotes(line);
    if (!raw)
        return { kind: 'ignore', message: '' };
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return interpretPastedCodeOrQuery(raw, config, expectedState);
    }
    if (!isLoopbackHostname(url.hostname) || url.pathname !== config.callbackPath) {
        return {
            kind: 'ignore',
            message: `Paste the redirected localhost URL from the address bar (${config.exampleCallbackUrl}).`,
        };
    }
    const result = interpretCallbackParams(config, expectedState, url.searchParams.get('error'), url.searchParams.get('code'), url.searchParams.get('state'));
    return result instanceof Error ? { kind: 'fail', error: result } : { kind: 'code', code: result };
}
/**
 * Waits for the authorization callback on `server` and resolves with the
 * authorization code.
 *
 * Resolves from either the browser's loopback request or a pasted redirect, so a
 * remote host — where the browser cannot reach this process's loopback port —
 * can still complete the login.
 */
export function awaitLoopbackCallback(server, config, expectedState, options = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let paste;
        const cleanup = () => {
            options.signal?.removeEventListener('abort', onAbort);
            server.off('error', onError);
            paste?.close();
        };
        const doResolve = (value) => {
            cleanup();
            resolve(value);
        };
        const doReject = (err) => {
            cleanup();
            reject(err);
        };
        if (options.signal?.aborted) {
            doReject(new Error(`${config.label} login cancelled`));
            return;
        }
        const onAbort = () => {
            settled = true;
            closeLoopbackServer(server);
            doReject(new Error(`${config.label} login cancelled`));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        // The callback is single-use. A retried or duplicated request after the
        // socket has been torn down must not run the handler a second time.
        server.on('request', (req, res) => {
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
            const result = interpretCallbackParams(config, expectedState, requestUrl.searchParams.get('error'), requestUrl.searchParams.get('code'), requestUrl.searchParams.get('state'));
            const failure = result instanceof Error ? result : null;
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
            res.end(failure ? `${failure.message}\nYou can close this tab.` : 'Login complete. You can close this tab.');
            // Free the callback port immediately: a keep-alive browser socket would
            // otherwise hold it and make the next login attempt fail.
            closeLoopbackServer(server);
            if (failure)
                doReject(failure);
            else
                doResolve(result);
        });
        if (options.pasteInput) {
            paste = readline.createInterface({ input: options.pasteInput, crlfDelay: Infinity });
            paste.on('line', (line) => {
                if (settled)
                    return;
                const interpreted = interpretPastedOAuthRedirect(line, config, expectedState);
                if (interpreted.kind === 'ignore') {
                    if (interpreted.message)
                        options.onPasteRejected?.(interpreted.message);
                    return;
                }
                settled = true;
                closeLoopbackServer(server);
                if (interpreted.kind === 'fail')
                    doReject(interpreted.error);
                else
                    doResolve(interpreted.code);
            });
        }
        const onError = (err) => {
            doReject(err);
        };
        server.on('error', onError);
    });
}
//# sourceMappingURL=oauth-loopback.js.map