# MCP Milestone 0 SDK compatibility

## Recommendation

Use the v2 split packages as the implementation line:

- `@modelcontextprotocol/client@2.0.0` for MCP clients.
- `@modelcontextprotocol/server@2.0.0` only for v2 test fixtures or servers owned by
  term2 (term2 itself does not need to host MCP servers).
- Keep `@modelcontextprotocol/sdk@1.30.0` available as a compatibility fallback for
  v1-only behavior and legacy servers, especially if a real server later fails v2
  negotiation. The two client implementations coexist in one ESM Node project; the
  v1 client must use its documented subpath imports because the package root in the
  published 1.30.0 tarball points at a missing `dist/esm/index.js`.

The v2 client is the preferred default: in the runnable matrix it connected to and
called tools on v1 stdio, v1 Streamable HTTP, v1 legacy HTTP+SSE, and a v2 Streamable
HTTP server. This is stronger evidence than relying on the package README's version
claim. Keep the v1 fallback because compatibility with arbitrary handshake-era or
older legacy servers was not exhaustively established by this small fixture set.

## Compatibility matrix

The exact required verification command was run:

```text
["bash","-lc","cd spikes/mcp/sdk && npm run matrix"]
```

Observed output (2026-09-17):

| Client | Server fixture | Result | Observed call result |
|---|---|---|---|
| v1 `@modelcontextprotocol/sdk@1.30.0` | v1 stdio | Works | `content: [{type:"text",text:"hello from v1"}]`, `structuredContent: {answer:42}` |
| v1 | v1 Streamable HTTP | Works | same |
| v1 | v1 HTTP+SSE | Works | same |
| v2 `@modelcontextprotocol/client@2.0.0` | v1 stdio | Works | same |
| v2 | v1 Streamable HTTP | Works | same |
| v2 | v1 HTTP+SSE | Works | same |
| v2 | v2 Streamable HTTP (`@modelcontextprotocol/server@2.0.0`) | Works | `content: [{type:"text",text:"hello from v2"}]`, `structuredContent: {answer:84}` |

The matrix printed `HARNESS: OK` and exited 0. Each v1 fixture is built with
`McpServer` from v1. The v2 fixture uses v2 `McpServer` + `createMcpHandler`.
The legacy SSE transport is deprecated in the v1 declarations, but the live cell
worked and should remain supported for migration compatibility.

### Coexistence and ESM

The same `tsx`-executed ESM `.ts` process imported both lines and printed:

```text
ESM .ts imports via tsx: {"v1Client":"function","v2Client":"function","v2Streamable":"function"}
```

The v1 imports used by the spike are:

```ts
@modelcontextprotocol/sdk/client/index.js
@modelcontextprotocol/sdk/client/stdio.js
@modelcontextprotocol/sdk/client/streamableHttp.js
@modelcontextprotocol/sdk/client/sse.js
```

This matches term2's root `package.json` (`"type":"module"`, Node `>=20`, and
`tsx` scripts). The v2 client exposes stdio from `@modelcontextprotocol/client/stdio`
and HTTP transports from the main client entry point.

## API facts needed by the implementation

These were exercised or inspected by `npm run matrix`; the declarations are in the
installed package files under `spikes/mcp/sdk/node_modules/`.

- **Tool listing and pagination:** `client.listTools(params?)` accepts a request
  containing `cursor` and returns `{tools, nextCursor?}`. The fixture call passed
  `cursor: undefined`, then passed the returned cursor back. The fixture had four
  tools and returned `nextCursor: null`, so it did not force a second page. A real
  pagination boundary remains **UNVERIFIED** by this fixture.
- **Calling tools:** `client.callTool({name, arguments})` returns a result with
  `content`, optional `structuredContent`, and optional `isError`. The live result
  contained both `content` and `structuredContent`; no `isError` was returned for a
  successful call.
- **`tools/list_changed`:** v2 `Client.prototype.setNotificationHandler` exists and
  the v2 notification type is `ToolListChangedNotification`. A live server-side
  list-change notification and refresh policy are **UNVERIFIED**.
- **Cancellation and timeouts:** `Client.prototype.callTool` accepts request
  options, and the v2 transport exposes `send` and `close`; the declarations include
  request abort signals and timeout options. A live in-flight abort/timeout test is
  **UNVERIFIED** and must be added before production behavior relies on exact error
  mapping.
- **Server process exit/crash:** the v2 client exposes `Client.closed`, documented
  as settling with a local/graceful/remote reason, and transports expose `onclose`
  / `onerror` in their declarations. A live child-crash assertion is **UNVERIFIED**;
  the spike only used child processes and explicit cleanup.
- **OAuth provider:** both v1 and v2 name the interface `OAuthClientProvider`. The
  required shape is `redirectUrl` getter, `clientMetadata` getter,
  `clientInformation()`, `tokens()`, `saveTokens(tokens)`,
  `redirectToAuthorization(url)`, `saveCodeVerifier(verifier)`, and
  `codeVerifier()`. `saveClientInformation` is optional; v2 also supports optional
  `state`, custom client authentication, resource validation, and credential
  invalidation. v2 methods can receive an authorization-server context. No OAuth
  flow or token persistence was run.

## Dependency weight

The matrix ran `du -sk` over the installed package directories and printed:

```text
dependency weight: {"@modelcontextprotocol/client":6664,"@modelcontextprotocol/server":6380,"@modelcontextprotocol/sdk":6220}
```

These are installed directory sizes in KiB, not compressed registry tarball sizes;
they include each package's local files but are not a complete deduplicated node_modules
footprint. The isolated spike installed 101 packages for all three SDK packages plus
`tsx`; `npm audit` reported zero vulnerabilities.

## Primary sources

- v2 client package README and exports: <https://www.npmjs.com/package/@modelcontextprotocol/client>
- v2 server package README and migration note: <https://www.npmjs.com/package/@modelcontextprotocol/server>
- v1 SDK package: <https://www.npmjs.com/package/@modelcontextprotocol/sdk>
- MCP TypeScript SDK repository: <https://github.com/modelcontextprotocol/typescript-sdk>
- MCP specification: <https://modelcontextprotocol.io/specification/2026-07-28>

## Reproduction and limitations

Spike source and rerun instructions are in `spikes/mcp/sdk/README.md`. The required
command exits non-zero only if the harness itself breaks; compatibility cell failures
are printed as evidence. The current fixture proves the listed transport combinations,
but not arbitrary pre-2025 handshake revisions, real pagination boundaries, live
notification refresh, abort/timeout error normalization, crash recovery, or OAuth.
