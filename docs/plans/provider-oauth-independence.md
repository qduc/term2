# Own the OAuth flow and the credential store for Grok and Codex

Status: **backlog items 1–3 implemented (2026-08-20).** Item 4 (device flow)
remains open, and the port question below is still unsettled.

## Resume here

Read this section before touching `source/providers/grok-auth.ts`,
`source/providers/codex-auth.ts`, `source/providers/oauth-pkce.ts`,
`source/providers/codex.provider.ts` (`CodexTokenManager`), or
`source/utils/ai/provider-credentials.ts`.

**What already landed.** Both hazards below are closed, and Codex has its own
login:

- `CodexTokenManager` reads term2's own store at
  `envPaths('term2').config/codex-auth.json` first and writes refreshes only
  there. It **never** writes `~/.codex/auth.json` again.
- Both CLI fallbacks are access-token-only imports, marked `imported: true`.
  When an imported token expires the manager refuses to refresh and tells the
  user to run `term2 --grok-login` / `term2 --codex-login`.
- Both stores hold **several accounts** with one active pointer
  (`providers/oauth-account-store.ts`). Each account owns its own refresh token,
  so switching never crosses two rotation chains. A pre-multi-account file is
  migrated on read, and reading alone never rewrites it. The switcher lives in
  Provider Management, in the slot where key-based providers open their key
  editor. Selecting an account is **pending, not immediate**: a running session
  stays pinned to the account it first resolved, because response chaining is
  bound to the identity that opened the chain, so the selection applies from the
  next term2 session. The menu shows both states — "in use" and "takes effect
  next session" — and `providers/oauth-session-account.ts` is what lets the UI
  tell them apart. Do not make selection take effect immediately without solving
  the chaining problem first.
- `term2 --codex-login` runs the same PKCE flow Grok has. The flow itself now
  lives once in `source/providers/oauth-pkce.ts`
  (`runPkceLoopbackLogin`); each provider contributes only endpoints, scopes,
  redirect, and body encoding.

Do not "restore" the write-back or the refresh-token import as a convenience —
they are the double-spend this plan exists to remove.

**The problem is writes and refresh tokens, not "dependency" in the abstract.**
xAI and OpenAI both rotate refresh tokens: each refresh invalidates the one
before it. Two processes holding the same refresh token are two writers on one
rotation chain, and the loser is silently logged out.

Two concrete instances exist today:

1. `CodexTokenManager.getOrRefreshAccessToken()` refreshes and then **writes
   back into `~/.codex/auth.json`** (tmp + rename, no lock). The `grok` CLI
   ships `auth.json.lock`, lock heartbeats, and explicit "sibling-rotation
   detected" handling for exactly this hazard; the `codex` CLI presumably
   assumes something similar. term2 does not speak that protocol.
2. `GrokTokenManager` falls back to `~/.grok/auth.json` and, when the token is
   stale, **refreshes using the CLI's refresh token** and stores the result in
   term2's own file. Same double-spend, read-side. This is a defect in shipped
   code, not a hypothetical.

**Decisions already taken.**

- Grok already has its own PKCE login (`loginToGrok`) and its own store at
  `envPaths('term2').config/grok-auth.json`, mode 0600. Nothing needs
  re-deriving there.
- The import path is worth keeping, but only as a **one-way, access-token-only
  grace**: copy the short-lived access token so an already-logged-in host works
  immediately, never the refresh token, and require `--grok-login` when it
  expires.

**Premises already disproven — do not re-derive.**

- *"Register our own OAuth client and pick our own redirect."* Almost certainly
  a dead end for subscription access. The CLI chat proxy
  (`https://cli-chat-proxy.grok.com/v1`) gates on the `grok` CLI's client id and
  its `grok-cli:access` scope. A term2-registered client would authenticate and
  then be refused by the proxy. Borrowing the client id is what buys access;
  inheriting its registered redirect is the price.
- *"Probe whether auth.x.ai honours RFC 8252 loopback-port flexibility with
  curl."* Already tried. `GET /oauth2/authorize` returns an identical Cloudflare
  403 for the registered port and an unregistered one, so the probe measures bot
  protection, not redirect policy. It cannot settle the question headlessly.

**Settled for OpenAI (2026-08-20): the redirect is an allow-list, not RFC 8252
port flexibility.** The codex CLI is open source, and
`codex-rs/login/src/server.rs` hardcodes exactly two ports — 1455 with a 1457
fallback — under the comment *"Keep in sync with the Codex CLI Hydra redirect
URI allow-list."* A fixed two-entry fallback is only necessary if arbitrary
ports are refused. term2 now binds the same list. This is evidence about
`auth.openai.com` only; it makes exact-match likelier for `auth.x.ai` but does
not prove it.

Reading that source also corrected three things we had wrong: the scope set was
missing `api.connectors.read` / `api.connectors.invoke`, the `originator`
parameter was absent, and there was no port fallback. Prefer reading the CLI
source over inferring the wire — it is the cheapest evidence available for the
Codex half.

## Open question, and the cheapest way to settle it

**For Grok: is `http://localhost:22255/callback` matched exactly, or is any
loopback port accepted?** (The OpenAI half is settled above.) RFC 8252 §7.3 tells native-app servers to ignore the loopback port;
many do. The `grok` binary hardcodes one port with no fallback range, which
weakly suggests exact match.

Settle it with one interactive login attempt using a different port. Sign-in
page → ports are free, bind `:0` and take whatever the OS gives. "Invalid
redirect_uri" → exact match, and the port is not negotiable.

If it is exact match, **do not fight for the port — switch to the device code
grant.** `https://auth.x.ai/.well-known/openid-configuration` advertises
`device_authorization_endpoint` (`/oauth2/device/code`) and lists
`urn:ietf:params:oauth:grant-type:device_code` among its grant types; the `grok`
binary implements it. Device flow needs no listener at all, so it removes rather
than reports the `EADDRINUSE` collision with a concurrent `grok login`, and it
works over SSH and on headless hosts — which matters because term2 has an
`--ssh` mode where opening a browser cannot work.

## Backlog, ranked by value (not by effort)

Items 1–3 are **done**; item 4 is open.


1. **Stop writing to other tools' credential files.** Codex refreshes land in
   term2's own store. Highest value: it retires the live double-spend hazard
   without any new login flow.
2. **Access-token-only import.** Change `GrokTokenManager`'s CLI fallback to
   never carry `refresh_token`, and do the same for the Codex read path.
3. **Own login for Codex.** The same PKCE flow Grok has. Public client
   `app_EMoamEEZ73f0CkXaXp7hrann`, loopback `http://localhost:1455/auth/callback`
   (subject to the same port question as above).
4. **Device flow**, if the port probe says exact match — or unconditionally, if
   headless/SSH login is wanted for its own sake.

Items 1 and 2 remove the hazard on their own. Item 3 is the part that costs a
second login on hosts that already run both CLIs, and it is the part that breaks
when a provider changes its flow — take it deliberately, not by momentum.

## Reference: what is already known about the wire

Facts established by inspecting `~/.grok/bin/grok` and live requests; they are
not guesses, but re-verify before relying on them.

- Issuer `https://auth.x.ai`; authorize `/oauth2/authorize`; token
  `/oauth2/token`; device code `/oauth2/device/code`; PKCE `S256` only.
- Public desktop client id `b1a00492-073a-47ea-816f-4c329264a828`; registered
  redirect `http://localhost:22255/callback`.
- Subscription traffic goes to `https://cli-chat-proxy.grok.com/v1`, which
  speaks OpenAI chat completions (with a `reasoning_content` lane).
- That proxy **rejects unrecognised clients with HTTP 426**, so
  `x-grok-client-version` is load-bearing. term2 pins `1.0.5`
  (`GROK_CLIENT_VERSION` in `source/providers/grok.provider.ts`); raise it when
  the proxy starts refusing that floor.
- Grok models are absent from the generated model catalog (it is generated from
  models.dev), so pricing and context-window lookups fall back to defaults.
