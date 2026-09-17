import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
} from '@modelcontextprotocol/server';

/**
 * An MCP server that requires a bearer token and publishes RFC 9728 protected
 * resource metadata pointing at its authorization server — the shape a client
 * hits when it connects to an OAuth-protected remote server.
 *
 * Serving goes through the real v2 SDK handler, so a test that reaches a tool
 * here has done the actual MCP handshake over Streamable HTTP.
 */
export type ProtectedMcpServerOptions = {
  /** The authorization server's issuer identifier. */
  authorizationServerUrl: string;
  /** Returns the auth info for a token, or null when the token is not valid. */
  verifyToken: (token: string) => Promise<{ clientId: string; scopes: string[]; expiresAt: number } | null>;
};

export type ProtectedMcpServer = {
  /** Base URL of the MCP endpoint. */
  url: string;
  /** RFC 9728 metadata URL advertised in the 401 challenge. */
  resourceMetadataUrl: string;
  /** Every HTTP request the fixture has seen, including refused ones. */
  requestCount: () => number;
  stop: () => Promise<void>;
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

async function toResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}

/** Builds one `Request` and lets each gate read from it. */
async function asRequest(req: IncomingMessage, url: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

export async function startProtectedMcpServer(options: ProtectedMcpServerOptions): Promise<ProtectedMcpServer> {
  let origin = '';
  let requests = 0;

  const resourceUrl = () => `${origin}/mcp`;
  const resourceMetadataUrl = () => getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl()));

  const mcp = new McpServer({ name: 'protected-fixture', version: '1.0.0' });
  mcp.registerTool('echo', { description: 'reports that the server is reachable' }, async () => ({
    content: [{ type: 'text' as const, text: 'echo' }],
  }));
  const handler = createMcpHandler(() => mcp);

  const verifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const verified = await options.verifyToken(token);
      if (!verified) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown access token');
      return { token, clientId: verified.clientId, scopes: verified.scopes, expiresAt: verified.expiresAt };
    },
  };
  // Rebuilt per request because the challenge must advertise the metadata URL of
  // the port the server actually bound, which is only known after `listen`.
  const gate = (request: Request) =>
    requireBearerAuth({ verifier, resourceMetadataUrl: resourceMetadataUrl() })(request);

  const server = createServer(async (req, res) => {
    requests += 1;
    const request = await asRequest(req, `http://${req.headers.host}${req.url}`);

    // The protected-resource document is what an unauthenticated client reads to
    // find the authorization server; it must not require a token itself.
    const metadata = oauthMetadataResponse(request, {
      oauthMetadata: {
        issuer: options.authorizationServerUrl,
        authorization_endpoint: `${options.authorizationServerUrl}/authorize`,
        token_endpoint: `${options.authorizationServerUrl}/token`,
        registration_endpoint: `${options.authorizationServerUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      },
      resourceServerUrl: new URL(resourceUrl()),
      resourceName: 'protected-fixture',
      scopesSupported: ['mcp'],
    });
    if (metadata) return toResponse(res, metadata);

    const auth = await gate(request);
    if (auth instanceof Response) return toResponse(res, auth);

    return toResponse(res, await handler.fetch(request, { authInfo: auth }));
  });

  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  return {
    url: resourceUrl(),
    resourceMetadataUrl: resourceMetadataUrl(),
    requestCount: () => requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
