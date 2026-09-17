# M0 spike — MCP test servers and catalog cost

Status: measured 2026-09-17 (worktree `mcp-m0-servers`, task `M0-servers`, worker `W-glm`).
All claims below cite a command run in `spikes/mcp/servers/` of this worktree plus its
observed output, unless marked **UNVERIFIED**. Raw evidence: `spikes/mcp/servers/catalogs/*.json`.

## Chosen servers

| Role | Source / version | Transport | Auth needed | Runnable in CI offline |
|---|---|---|---|---|
| Small local stdio | `@modelcontextprotocol/server-everything` 2026.8.31 (npm) | stdio (`mcp-server-everything`) | none | Yes, with pinned deps in the image |
| Large local stdio | `github/github-mcp-server` v1.12.2 (Go binary release, `Linux_x86_64.tar.gz`, commit `85598ba6`) | stdio (`github-mcp-server stdio --toolsets all`) | **none to list tools**; a GitHub token only for tool calls | Yes, if the binary is cached (30MB download otherwise); no docker needed |
| Streamable HTTP local | same server-everything, `streamableHttp` mode | Streamable HTTP at `http://localhost:3001/mcp` | none | Yes, local process |
| Public remote, OAuth | Linear MCP `https://mcp.linear.app/mcp` (fallback observed: GitHub remote `https://api.githubcopilot.com/mcp/`) | Streamable HTTP | OAuth 2.1 — **not authenticated** (per task); 401 evidence below | No (needs network); used unauthenticated for 401/discovery tests only |
| Legacy HTTP+SSE local | same server-everything, `sse` mode | HTTP+SSE at `http://localhost:3001/sse` | none | Yes, local process |

server-everything's published bin covers all three local transports
(`"stdio"`, `"sse"`, `"streamableHttp"` present in `dist/index.js`), so one package fills
four of the five roles.

## Observed connection facts

- **GitHub server lists tools with no token.**
  `./node_modules/.bin/tsx list.ts github-stdio-notoken stdio -- /tmp/github-mcp-server stdio --toolsets all`
  → `90 tools across 1 page(s)`, server name `github-mcp-server` version `1.12.2`.
  Listing is free; only authenticated calls need a token. **UNVERIFIED** (not attempted): that calls
  without a token fail.
- **Linear retired `/sse`.** `POST https://mcp.linear.app/sse` → `404 Not Found`;
  its protected-resource metadata advertises `resource: https://mcp.linear.app/mcp`.
- **Linear `/mcp` OAuth challenge (nothing authenticated).**
  `tsx probe-oauth.ts oauth-linear-mcp https://mcp.linear.app/mcp` →
  `401`, `www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
  then `200` for both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
  (root and `/mcp` path-aware variants).
- **GitHub remote challenge.** `POST https://api.githubcopilot.com/mcp/` → `401`,
  `www-authenticate: Bearer error="invalid_request", ... resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"`;
  that metadata URL is `200`, but `/.well-known/oauth-authorization-server{,/mcp}` are `404` —
  the authorization-server endpoints are discovered through the protected-resource document, not
  a fixed well-known path. Saved in `catalogs/oauth-github-remote.json`.
- **Pagination untested by these servers.** Every catalog came back in 1 page (`pages: 1`,
  no `nextCursor`); the list harness follows cursors but no server exercised it.
- **serverInfo can be bulky.** `github-mcp-server` returns two inline base64 PNG icons in
  `initialize` result; the raw saved catalog is 332KB while the 90 tool definitions alone are
  ~257KB (`catalogs/github-stdio-notoken.json`).

## Measurement table

`npx tsx measure.ts --from-saved` (tokens estimated as **chars/4** — an approximation, not a tokenizer):

| Server | Tools | Invalid JS names | `schema unavailable` | (a) compact listing | (b) names-only | (c) raw JSON | `outputSchema` | `readOnlyHint` | `destructiveHint` | desc max/median (chars) |
|---|---|---|---|---|---|---|---|---|---|---|
| everything-stdio | 13 | 12 | 0/13 | 755 (~189 tok) | 328 (~82 tok) | 7,653 (~1,913 tok) | 1 | 9 | 0 | 270 / 60 |
| everything-http | 13 | 12 | 0/13 | 755 (~189 tok) | 328 (~82 tok) | 7,653 (~1,913 tok) | 1 | 9 | 0 | 270 / 60 |
| everything-sse | 13 | 12 | 0/13 | 755 (~189 tok) | 328 (~82 tok) | 7,653 (~1,913 tok) | 1 | 9 | 0 | 270 / 60 |
| github-stdio-notoken | 90 | 0 | 0/90 | 14,634 (~3,659 tok) | 2,292 (~573 tok) | 256,560 (~64,140 tok) | 0 | 56 | 7 | 1,115 / 77 |

Notes:

- "compact listing" is one `- tools.name({ ... })` bullet per tool, rendered with term2's real
  `renderCompactSignature` (imported from `source/tools/system/run-code/tools-header.ts`; not reimplemented).
  "names-only" is one `tools.<name>` line per tool.
- server-everything names are kebab-case (`get-annotated-message`, `get-env`, ...), so 12 of 13 are
  not valid JS identifiers — the `tools.<server>.<tool>` namespacing scheme needs the documented
  mangling rule flagged in the plan.
- `renderCompactSignature` degraded **zero** schemas to "schema unavailable" across all 103 tools,
  including GitHub's deep nested-object inputs. Header cost, not schema rendering, is the scaling problem.
- GitHub with all toolsets: full compact catalog ≈ 3.7k tokens vs ≈ 64k tokens raw — ~17× — and
  names-only ≈ 0.6k tokens. Per-server one-liner + names + `tools.describe` looks viable; full
  signatures for GitHub alone would be the largest item in the `run_code` header by far.
- Prompt-injection surface: GitHub's longest tool description is 1,115 chars (median 77); all 103
  tools carry descriptions, so a header that omits descriptions loses nothing for discovery.

## Blockers

None blocking M0. Carry-forwards:

1. GitHub server needs a token only for **calls**; M1 integration tests can list/catalog without
   credentials but cannot execute calls offline without a real token.
2. No tested server exercises `tools/list` pagination; a paginating server (or a wrapped mock)
   should cover that path in M1 tests.
3. `destructiveHint` is set on only 7/90 GitHub tools — annotations are too sparse to drive any
   approval policy (consistent with the plan's decision to treat them as untrusted hints).
