import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * An offline OAuth 2.1 authorization server for MCP flow tests: RFC 8414 metadata
 * discovery, an `/authorize` endpoint that records the PKCE challenge, a `/token`
 * endpoint that validates the S256 verifier and rotates refresh tokens, and an
 * RFC 7591 `/register` endpoint for dynamic client registration.
 *
 * Deliberately strict: a flow that skips PKCE, reuses a code, or sends the wrong
 * redirect URI fails here rather than in the client, so a green test means the
 * client really did the protocol work.
 */
export type FakeAuthorizationServer = {
  /** Issuer identifier; also the base URL clients discover and talk to. */
  issuer: string;
  /** Access tokens issued so far, in order. */
  issuedAccessTokens: string[];
  /** Refresh tokens presented on a refresh grant, in order. */
  refreshGrants: string[];
  /** Client ids handed out by `/register`, in order. */
  registeredClientIds: string[];
  /** Requests refused because the PKCE verifier or the code did not check out. */
  refusedTokenRequests: number;
  stop: () => Promise<void>;
};

type PendingCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
};

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

const s256 = (verifier: string): string => crypto.createHash('sha256').update(verifier).digest('base64url');

export async function startFakeAuthorizationServer(): Promise<FakeAuthorizationServer> {
  const codes = new Map<string, PendingCode>();
  const knownRefreshTokens = new Set<string>();
  const state: FakeAuthorizationServer = {
    issuer: '',
    issuedAccessTokens: [],
    refreshGrants: [],
    registeredClientIds: [],
    refusedTokenRequests: 0,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const issueTokens = () => {
    const accessToken = `at-${crypto.randomUUID()}`;
    const refreshToken = `rt-${crypto.randomUUID()}`;
    state.issuedAccessTokens.push(accessToken);
    knownRefreshTokens.add(refreshToken);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 };
  };

  const handleAuthorize = (url: URL, res: ServerResponse) => {
    const redirectUri = url.searchParams.get('redirect_uri');
    const codeChallenge = url.searchParams.get('code_challenge');
    const clientId = url.searchParams.get('client_id');
    if (url.searchParams.get('response_type') !== 'code') {
      return sendError(res, 400, 'unsupported_response_type', 'only the code response type is supported');
    }
    if (url.searchParams.get('code_challenge_method') !== 'S256') {
      return sendError(res, 400, 'invalid_request', 'code_challenge_method must be S256');
    }
    if (!codeChallenge || !redirectUri || !clientId) {
      return sendError(res, 400, 'invalid_request', 'client_id, redirect_uri and code_challenge are required');
    }

    const code = `code-${crypto.randomUUID()}`;
    codes.set(code, { clientId, redirectUri, codeChallenge });
    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    const clientState = url.searchParams.get('state');
    if (clientState) location.searchParams.set('state', clientState);
    // The user is never asked to consent: this server approves every request.
    res.writeHead(302, { Location: location.href });
    res.end();
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse) => {
    const params = new URLSearchParams(await readBody(req));
    const grantType = params.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const pending = codes.get(code);
      // Single use: a replayed code must not mint a second token set.
      codes.delete(code);
      const verifier = params.get('code_verifier') ?? '';
      if (!pending) return refuse(res, 'unknown or already-used authorization code');
      if (pending.redirectUri !== params.get('redirect_uri')) return refuse(res, 'redirect_uri does not match');
      if (pending.clientId !== params.get('client_id')) return refuse(res, 'client_id does not match');
      if (pending.codeChallenge !== s256(verifier)) {
        return refuse(res, 'code_verifier does not match the S256 challenge');
      }
      return sendJson(res, 200, issueTokens());
    }

    if (grantType === 'refresh_token') {
      const presented = params.get('refresh_token') ?? '';
      if (!knownRefreshTokens.has(presented)) return refuse(res, 'unknown refresh token');
      state.refreshGrants.push(presented);
      // Rotation: the presented refresh token is spent by this grant.
      knownRefreshTokens.delete(presented);
      return sendJson(res, 200, issueTokens());
    }

    return sendError(res, 400, 'unsupported_grant_type', `unsupported grant_type: ${grantType ?? '(missing)'}`);
  };

  const refuse = (res: ServerResponse, reason: string): void => {
    state.refusedTokenRequests += 1;
    sendError(res, 400, 'invalid_grant', reason);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', state.issuer || 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        return sendJson(res, 200, {
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          registration_endpoint: `${state.issuer}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['mcp'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/authorize') return handleAuthorize(url, res);
      if (req.method === 'POST' && url.pathname === '/token') return await handleToken(req, res);
      if (req.method === 'POST' && url.pathname === '/register') {
        // RFC 7591: the response carries the client id plus the metadata that
        // was registered, which the client validates against its own request.
        const metadata = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        const clientId = `dcr-${state.registeredClientIds.length + 1}`;
        state.registeredClientIds.push(clientId);
        return sendJson(res, 201, {
          ...metadata,
          client_id: clientId,
          token_endpoint_auth_method: 'none',
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
      }
      sendJson(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      sendJson(res, 500, { error: 'server_error', error_description: String(error) });
    }
  });

  const port = await listen(server);
  state.issuer = `http://127.0.0.1:${port}`;
  return state;
}
