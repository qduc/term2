# M2 OAuth core — delivery report

Status: **delivered** (worker W-ds, branch `mcp-m2-oauth-core`, 2026-09-17). Scope is the
decision-independent half of MCP OAuth: credential storage, the SDK provider adapter, a reusable
loopback redirect helper, and offline test fixtures. Deliberately **not** included: connection-manager
wiring, a login command, catalog states — all blocked on `.coord/mcp-code-mode/PARKED-DECISIONS.md`
D1–D4.

## What was built

### `source/services/mcp/mcp-oauth-store.ts` — credential store

One JSON file (`mcp-oauth.json`) in term2's config dir, resolved the same way as `grok-auth.ts`
(`process.env.TERM2_CONFIG_DIR || envPaths('term2').config`). Written through a same-directory
temporary file (`openSync(tmp, 'w', 0o600)` → write → `fsyncSync` → `renameSync`), with stale temp
files swept at construction — the `OAuthAccountStore` pattern, reimplemented because MCP credentials
are keyed differently.

Keying: `normalizeMcpServerUrl()` (lowercase scheme and host, default port dropped, trailing slash
dropped, query/fragment dropped, path case kept) is the outer key, so renaming a config entry never
reaches another server's token. Inside a server entry, client information and tokens are sub-keyed by
the authorization server `issuer` the SDK stamps on them; the PKCE code verifier and the discovery
state are per-server because the SDK passes no issuer context for them.

API: `read()`, `getClientInformation`/`saveClientInformation`, `getTokens`/`saveTokens`,
`getCodeVerifier`/`saveCodeVerifier`, `getDiscoveryState`/`saveDiscoveryState`,
`invalidateCredentials(serverUrl, scope)`, plus `defaultMcpOAuthStorePath()` and
`normalizeMcpServerUrl()`. Injectable `filePath` and `filesystem` seams; no module-level state.

### `source/services/mcp/mcp-oauth-provider.ts` — SDK adapter

`McpOAuthProvider implements OAuthClientProvider`: `redirectUrl` (string or thunk, for a port chosen at
runtime), `clientMetadata`, `state()`/`authorizationState`, `clientInformation`/`saveClientInformation`,
`tokens`/`saveTokens`, `redirectToAuthorization`, `saveCodeVerifier`/`codeVerifier`,
`saveDiscoveryState`/`discoveryState`, `invalidateCredentials`, and the optional `clientMetadataUrl`
(CIMD), validated in the constructor with the SDK's `validateClientMetadataUrl()`.

Every policy decision is injected: `onAuthorizationRedirect` receives the URL and does whatever the
caller decides (open a browser, show it, refuse). No browser, approval, catalog, or config code lives
here.

### `source/lib/oauth-loopback.ts` — shared loopback redirect

Extracted from `source/providers/oauth-pkce.ts`: `bindLoopbackRedirect(options)` (port preference list,
`[0]`/ephemeral by default, always the literal `127.0.0.1`), `awaitLoopbackCallback(server, config,
state, options)` (browser callback or pasted redirect, single-use, state-checked, abortable),
`openInBrowser`, and `closeLoopbackServer`. `oauth-pkce.ts` now imports these and keeps only the
provider-specific parts (registered client ids, endpoints, token exchange); its tests are unchanged
and still pass.

### `source/services/mcp/test-fixtures/` — offline fixtures

- `fake-authorization-server.ts`: RFC 8414 metadata, `/authorize` requiring
  `code_challenge_method=S256`, single-use codes, `/token` validating the S256 verifier, redirect URI
  and client id before issuing tokens, refresh grants that rotate (and spend) the refresh token, and an
  RFC 7591 `/register` that echoes the registered metadata.
- `protected-mcp-server.ts`: an MCP server behind `requireBearerAuth`, publishing RFC 9728 metadata via
  `oauthMetadataResponse` and serving real MCP over Streamable HTTP with `createMcpHandler`.

Both bind ephemeral loopback ports and make no external requests.

## Design choices

- **`grant_types: ['authorization_code', 'refresh_token']`** (research doc proposed
  `['authorization_code']`). The SDK's `determineScope()` only appends `offline_access` when the client
  metadata declares `refresh_token`, and `fetchToken` needs the stored refresh token to survive. Without
  it, the milestone's "including token refresh" would depend on servers volunteering a refresh token.
- **Issuer-shape strictness.** `clientInformation()` and the two `save*` methods throw when no issuer is
  available rather than guessing: a client id is only meaningful to the authorization server that
  issued it, and the SDK always passes a context on these calls. `tokens()` with no context does return
  the most recently saved set, because the SDK documents that read (the transport's per-request bearer
  read) and explicitly requires it not to come back empty.
- **`lastIssuer` in the store.** `tokens()` without a context must mean "most recently saved". JSON key
  order cannot express "most recently *updated*", so the entry records it explicitly.
- **`state()` records the value it returns** (`authorizationState`), because term2 owns the loopback
  listener and must compare the callback's `state` against the exact value the SDK put in the
  authorization URL. PKCE + state stay in memory per flow and are never written to disk.
- **`codeVerifier()` throws when nothing is stored.** A token exchange with no verifier is a
  programming error; returning `undefined` (typed as `string`) would be a lie.
- **`invalidateCredentials` scopes.** `'client'`/`'tokens'` clear every issuer's entry (the call carries
  no context), `'verifier'`/`'discovery'` clear the per-server fields, `'all'` removes the entry.

## Tests

| File | What it proves |
| --- | --- |
| `source/services/mcp/mcp-oauth-store.test.ts` (14) | URL normalization equivalence; round-trip of client info, tokens, verifier and discovery state; `0o600` on disk; equivalent URL spellings share one entry; different URLs never share tokens; issuer sub-keying; most-recent-issuer read; corrupt file yields an empty store without throwing and is replaced by the next write; stale temp files swept; the exact tmp → write → fsync → close → rename sequence; a failed rename leaves the previous credentials intact with no temp file behind; `invalidateCredentials` scope-by-scope and server-by-server |
| `source/services/mcp/mcp-oauth-provider.test.ts` (14) | Interface conformance (typed assignment plus a behavioral call); client metadata; runtime redirect-URL thunk; per-issuer credential storage; no-context token read; refusal to guess an issuer; verifier round-trip and the missing-verifier error; state value exposed for callback validation; redirect delegation; discovery-state round-trip; invalidation scopes; CIMD acceptance and rejection |
| `source/services/mcp/mcp-oauth-flow.test.ts` (4) | The protected fixture refuses an unauthenticated request and advertises its authorization server; the real SDK `auth()` discovers the AS from that metadata, returns `REDIRECT` with an S256 PKCE challenge and a state the provider can validate, redeems the code, stores tokens (with the callback leg binding the issuer from persisted discovery state), and then refreshes — one browser trip, rotated refresh token, the access token actually accepted by the resource server; a wrong `code_verifier` is refused with `invalid_grant`; a real MCP client with the obtained token lists the fixture's tool |
| `source/lib/oauth-loopback.test.ts` (7) | ephemeral bind on `127.0.0.1`; preferred-port fallback; the all-ports-taken error naming the client and the conflict hint; callback capture with matching state; state mismatch rejected; a non-callback path 404s and the wait continues; abort |
| `source/providers/oauth-pkce.test.ts` (10, unchanged) | the provider login flow behaves exactly as before the extraction |

## Gate outputs

```
$ NODE_ENV=test pnpm exec vitest run source/services/mcp source/providers/oauth-pkce.test.ts source/lib && pnpm typecheck
 Test Files  30 passed (30)
      Tests  524 passed (524)
$ tsc --noEmit   (clean)
```

```
$ pnpm test:related ./source/lib/oauth-loopback.ts ./source/providers/oauth-pkce.ts ./source/services/mcp/mcp-oauth-store.ts ./source/services/mcp/mcp-oauth-provider.ts
 Test Files  182 passed (182)
      Tests  3187 passed | 2 expected fail | 1 skipped (3190)
 Duration  89.61s
```

```
$ pnpm lint
[ELIFECYCLE] Command failed with exit code 1.
[warn] Code style issues found in 34 files. Forgot to run Prettier?
```

`pnpm lint` = `eslint . && prettier --check .`: **eslint passes**, and the failure is `prettier
--check` on **34 files that are already unformatted on `main`** (`docs/test-audit/`,
`scripts/experiments/`, `scripts/run-deterministic-lane.mjs`, …). None of this change's files are in
that list — checked by intersecting the offender list with `git status`/`git diff --name-only`. Per the
delivery rules the pre-existing failure is left alone.

## Corrections to `M2-oauth-seams.md`

- **Interface list is incomplete and partly wrong.** `redirectUrl` and `clientMetadata` are property
getters, not methods; the interface also carries optional `addClientAuthentication`,
`validateResourceURL`, `prepareTokenRequest`, deprecated `saveAuthorizationServerUrl`/
`authorizationServerUrl`, and `saveResourceUrl`/`resourceUrl`. `clientMetadataUrl` is a property on the
provider, not just a constructor input.
- **`grant_types`** as noted above.
- **The parenthetical "the SDK never reads `authorizationServerUrl`" is right, but `auth()` still
  *writes* it** via the optional `saveAuthorizationServerUrl`. Not implementing it is safe; implementing
  it would be dead weight.
- **The server-side bearer helpers are verified, not unverified.** `requireBearerAuth`,
  `verifyBearerToken`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata` and
  `oauthMetadataResponse` all exist and work. One trap: `oauthMetadataResponse` serves only the
  *path-aware* protected-resource route (`/.well-known/oauth-protected-resource/<path>`), which is the
  one the client probes first, so the bare route is never needed.
- **`assertSecureTokenEndpoint`** (undocumented in the research) refuses a non-HTTPS token endpoint
  unless the host is loopback — the reason the fixtures can be `http://127.0.0.1` at all.
- **Fixture location** is `source/services/mcp/test-fixtures/` (colocated, repo convention) rather than
  the doc's `test/fixtures/mcp-oauth/`.
- **Store shape** adds `lastIssuer` to the server entry, for the reason above.

## Gaps and risks

- **Not wired anywhere, by design.** The connection manager still has no OAuth path, no login command,
  and no catalog state; D1–D4 gate that work.
- **The M2 wiring must bind the listener before the SDK reads `redirectUrl`**, and must pass
  `provider.authorizationState` to `awaitLoopbackCallback`. Both are contract obligations this slice
  cannot enforce; the flow test demonstrates the intended order.
- **Last-writer-wins between concurrent term2 instances.** The atomic write prevents a torn file, not a
  lost update (same as `OAuthAccountStore`). Each mutation rewrites the whole file.
- **No single-issuer invalidation**, because `invalidateCredentials(scope)` carries no issuer; a
  step-up flow that wants a narrower clear would need an API extension.
- **Discovery state is trusted as the callback leg's issuer binding.** The SDK requires it to survive
  the redirect; the store writes it to disk under `0o600`, which is the same trust level as the verifier.
- **zod 4.1.13 predates `~standard.jsonSchema`**, so the v2 server's typed `inputSchema: z.object({...})`
  overload does not typecheck in this repo (the runtime falls back to `z.toJSONSchema`, which works).
  The fixture's tool therefore takes no arguments. This is a pre-existing dependency gap that M3 test
  fixtures will hit again.
- **`prefers the first free port`** can flake if the OS hands the just-freed port to another process
  between the probe and the bind; it mirrors the existing `oauth-pkce.test.ts` helper.
