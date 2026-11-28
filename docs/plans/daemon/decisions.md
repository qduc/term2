# Singleton Daemon Decision Log

Each architectural, protocol, or operational decision made during the singleton daemon program is recorded here with its date, context, options weighed, choice, rationale, and link to any follow-up in `worth-revisiting.md`.

---

## D001 — Program plan baseline and state layout (2026-11-27)

- **Context:** Starting the singleton daemon program from `docs/plans/daemon/README.md` (originating on `claude/gracious-goldberg-7pbzpv` commit `8417a42`, cherry-picked onto `origin/main` `46b7a97`).
- **Choice:** Store program state in `docs/plans/daemon/` across `README.md` (status + Resume here), `criteria-and-threat-model.md` (Step 0 & Step 6), `decisions.md` (this file), `progress.md` (step ledger), and `worth-revisiting.md` (owner review items). Subsequent design/spec artifacts (Step 7 comparison, Step 8 scenarios, Step 9 inventory, Step 10 RFC spec, Step 11 zoom notes) live in the same folder.
- **Why:** Keeps `main` always green and resumable by any fresh orchestrator session without polluting the allowlisted repository root (`scripts/check-root.mjs`).

## D002 — Execution order of Step 12 (freeze) and Step 13 (session-list prototype) (2026-11-27)

- **Context:** `README.md` lists Step 12 ("Recheck the draft spec against what the zoom-ins found, then freeze under step 5's rule") before Step 13 ("Prototype the session-list stream against the draft spec and feed what it teaches back into review before anything freezes").
- **Choice:** Run Step 13 (prototype the session-list stream and wire the web sidebar against the draft Client API spec) **before** executing the Step 12 spec freeze, then incorporate prototype learnings into the final review round and freeze.
- **Why:** Step 13 explicitly states "feed what it teaches back into review before anything freezes". Freezing before prototyping would force an immediate reopen/version bump if the first real client uncovers wire friction.

## D003 — Move headless approval policy (`headlessPolicy`) into Host/Runtime (2026-11-27)

- **Context:** In-process `src/app/application.ts:headlessPolicy` currently reaches directly into `session.acceptedHistory()` and `runtime.surface.decideInteraction(...)` because headless clients do not see provider history over the wire.
- **Choice:** Move headless auto-approve / non-interactive approval evaluation inside the daemon/session runtime, configured via an explicit session/attach approval policy rather than running in the client process.
- **Why:** Under Step 6 criteria, keeping approval policy in the client either leaks provider history across the wire or weakens security authority. Keeping all approval policy inside Host/Runtime preserves single-arbiter authority and keeps clients thin.

## D004 — Dual-binding transport auth preserving current security posture (2026-11-27)

- **Context:** `DirectServerTransport` currently requires RS256 `x-term2-assertion` JWTs even over a local Unix socket (`0o660`), while local CLI surfaces (TUI, headless, control, Discord, ACP) run as the same OS user.
- **Choice:** The daemon serves the same core Client API over two transport bindings:
  1. **Local Unix domain socket** (`0700` runtime directory, `0600` socket file) authenticating as the local OS user principal without JWT ceremony.
  2. **HTTP + SSE (LAN / web BFF)** preserving existing `server-auth.ts` (RS256 assertions + `SqliteReplayLedger`), `server-pairing.ts` (OTP), and `server-trusted-clients.ts` unchanged.
- **Why:** Tightens local socket permissions (`0660` -> `0600`) without weakening or inventing new auth machinery, and eliminates unnecessary JWT overhead for local CLI clients while keeping LAN/web security intact.

## D005 — Keep TUI `!` bang-shell client-local (2026-11-27)

- **Context:** `launch-tui.tsx` (`integration.shell`) executes `!` bang-shell commands directly in the TUI process (disabled in SSH mode).
- **Choice:** Keep `!` bang-shell as a local terminal convenience in the TUI client (still disabled on remote/SSH sessions) rather than adding an unapproved arbitrary shell-execution RPC to the Client API.
- **Why:** Preserves local TTY/shell environment ergonomics and avoids exposing an approval-bypassing shell RPC over the Client API. Logged in `worth-revisiting.md`.

## D006 — Stage the Client API TypeScript schema + generated JSON Schema in `src/protocol/client-api/` before graduating to `@qduc/agent-wire` (2026-11-27)

- **Context:** Step 4 calls for one TypeScript schema in `@qduc/agent-wire` with JSON Schema generated from it. `@qduc/agent-wire` is maintained in the separate `qduc/agent-runtime` repository, which is outside this run's mounted project resources (`qduc/term2` only).
- **Choice:** Author the Client API schema as a self-contained, zero-Term2-internal-dependency module under `src/protocol/client-api/` (using Zod v4 + `z.toJSONSchema()` to generate `docs/plans/daemon/spec/client-api.schema.json`), and log its graduation into `qduc/agent-runtime` (`packages/wire`) in `worth-revisiting.md`.
- **Why:** Delivers a single authoritative TypeScript schema and generated JSON Schema immediately without touching an unmounted external repository or patching vendored tarballs (`vendor/README.md`). Keeping the module free of Term2-internal imports makes upstream graduation into `@qduc/agent-wire` mechanical.

## D007 — Unify conversation store and session visibility across local and web principals (2026-11-27)

- **Context:** Today `cli.ts` stores sessions in `<xdg-data>/term2/conversations-next` (unbound `DirectBinding` for local sessions) whereas `launch-serve.ts` isolates sessions in `<stateDir>/conversations` (`<data>/gateway-next/conversations`) with `binding: { client: ownerUserId, id: workspaceId }`.
- **Choice:** In daemon mode, one daemon owns the canonical `<xdg-data>/term2/conversations-next` store (unless overridden by `TERM2_CONVERSATIONS_DIR` / `--state-dir` for isolated test runs). Local Unix-socket owner clients auto-admit their local `cwd` and see all local-owner sessions; HTTP/web clients continue authorizing against explicit workspace grants (`DirectWorkspaceAuthority`), seeing sessions whose workspace root matches an authorized grant.
- **Why:** Required for the core goal ("one long-lived daemon owns every session and every UI is a client of it" — e.g. seeing a TUI session live in the web sidebar and attaching both UIs to the same session) while preserving explicit workspace-grant boundaries for web/LAN clients. Logged in `worth-revisiting.md` for migration of existing `<data>/gateway-next/conversations` history.

## D008 — Freeze Client API v1.0 after Review Round 2b + Step 13 prototype (2026-11-27)

- **Context:** Independent Spec Review Round 1 (2 reviewers across all 4 lenses) found 21 blocking issues; Round 2 found 3 blocking issues + 1 version-negotiation edge case; all were resolved and verified PASS in Round 2b. Both sides of the contract were zoomed (Step 11: Host/Runtime and Web Client), and Step 13 prototyped the full session-list stream end-to-end (`SessionIndex` → `GET /private/agent/v1/sessions/events` → Next.js BFF `GET /api/agent/sessions/events` → browser `session-list-stream.ts` → `server-data.ts` → live web sidebar, verified by conformance tests and 17/17 Chromium browser flows including background-session live updates).
- **Choice:** Freeze Client API `1.0` (`docs/plans/daemon/spec/{client-api,transport-unix,transport-http-sse}.md`, `src/protocol/client-api/client-api-schema.ts`, `docs/plans/daemon/spec/client-api.schema.json`). Any subsequent contract change MUST reopen design/review/freeze and negotiate via connect-time versioning per the standing rules.
- **Why:** All Step 5 freeze gates passed with zero open blocking findings and live end-to-end confirmation across both transport and browser boundaries.

## D009 — Stage TUI migration behind the existing application integration (2026-11-28)

- **Context:** The [TUI zoom-in](zoom/tui.md) found that the terminal UI's app
  adapter reads live runtime settings and owns several lifecycle operations.
  Client API v1.0 alone cannot express every operation the TUI uses today.
- **Choice:** Repair the existing workspace and attachment seams first. Keep
  Ink and terminal input behavior shared. Change the app adapter to consume an
  explicit backend, and reopen the Client API for the missing operations before
  routing TUI traffic through the daemon.
- **Why:** Side-by-side verification can exercise the same TUI in both modes.
  Smaller changes keep the existing entry point usable while the daemon backend
  gains parity.

## D010 — Reopen, review, and freeze Client API v1.1 (Unix minor bump) (2026-11-28)

- **Context:** Per D009 and the TUI + Step 14e surface zoom-ins (`zoom/tui.md`),
  Client API v1.0 lacked additive local-owner operations required for full TUI
  and local-surface parity: `session.launch` (workspace/selection/override
  admission before attach), `session.list { cwd }` + `messageCount`,
  `session.handoff { model }`, scoped TUI `settings.get`/`settings.subscribe`/
  `settings.update` (`view: "tui"`, `sessionId`, `persist`, `reset`, `requestId`),
  per-provider `models.list { provider, refresh }` with favorites/nicknames,
  `providers.upsert { keepApiKey, keepBaseUrl }`, `mcp.login { handoffUrl }`,
  and connection-bound local leases (`daemon.serve.start`/`stop`,
  `session.control.bind`/`rebind`/`unbind`, `session.acp.set_mcp`) gated behind
  the `local_leases` capability.
- **Choice:** Bump the Unix transport protocol version to `1.1` (backward
  compatible with `1.0`, strict connect-time version negotiation rejecting v1.1
  methods/fields on `1.0` connections) while keeping the HTTP+SSE transport
  pinned to `1.0` (`CLIENT_API_HTTP_VERSION = '1.0'`,
  `CLIENT_API_HTTP_CAPABILITIES`). Withhold `local_leases` from `protocol.hello`
  capabilities until Step 14e wires those lease handlers. Freeze `1.1` after two
  independent review rounds (Security/Threat-Model Lens 1 and Protocol/Conformance
  Lens 2 both returned PASS) and full schema + conformance verification.
- **Why:** Keeps v1.0 clients and the HTTP+SSE security boundary unchanged,
  avoids ad-hoc side channels for TUI/serve/control/ACP, enforces secret and URL
  credential/query/hash redaction on TUI settings projections, and honors Step 5's
  contract-freeze rule.

## D011 — Host `term2 serve` in the daemon behind a connection-bound lease (2026-11-28)

- **Context:** Step 14e Part 1. `transport-unix.md` §5.1 already froze
  `daemon.serve.start`/`stop` and `serve.pairing_otp`; nothing backed them, so
  `local_leases` stayed unadvertised (D010) and `term2 serve` still built its own
  host over `<stateDir>/conversations`.
- **Choice:**
  - The daemon composes the same serve stack (`src/app/serve/serve-composition.ts`)
    over its single application while one local connection holds the lease. The
    serve state directory still holds grants, trust, replay ledger, audit and the
    `serve.lock.sqlite` lock, so an in-process serve and a daemon lease cannot share
    a state directory. Conversations live in the daemon's store (D007).
  - One application now has two authorities. `DaemonServeLeases.authority` routes
    by principal (`via === 'local'` or not) and, for stored sessions, by the
    binding the session recorded. To make that possible the session store passes
    the recorded binding to `resolveWorkspace`, and `DirectAuthority.resolveStored`
    takes it as an optional third argument. Root alone could not decide: a local
    session and a web session can share a root.
  - Web callers keep in-process serve's posture exactly: they reach only sessions
    bound to them under a current grant. Unbound (local) sessions stay closed to
    them (404, as for another owner's session) even though the session index lists
    them under a covering grant (D007). Opening them to the web is a security
    decision left to the owner (worth-revisiting item 10).
  - Grant edits close only bound sessions in the root (`closeWorkspaceSessions`
    gains an `include` filter), so a web grant edit never ends a terminal's session.
    Bound sessions get serve's surface and never read the daemon's pending local
    launch policy, which could otherwise hand a web session a headless
    auto-approve policy during a concurrent local create.
  - One lease per daemon; a second `daemon.serve.start` answers `busy`. Releasing a
    lease (stop, EOF, shutdown) stops the listener and then closes every live
    web-bound session, even one a terminal is attached to. The first design left
    them running; the independent verifier showed a session opened under an
    `--allow-write` lease kept its write tools under a later read-only lease,
    because an open session keeps the tools its grant gave it and the HTTP
    authorize checks only that a grant exists with the same root. Closing them
    makes a later lease reopen them through its own grants, as an in-process
    restart does.
  - The first serve state directory a daemon store successfully serves from is recorded in
    `<daemon state dir>/serve-state-dir`; a lease naming another one is refused.
    Web-bound sessions record only `{ owner, grant id }` and every state directory
    has a `host` grant, so without the pin a lease with other keys or trusted
    devices could reach another state directory's `host` sessions. In-process serve
    kept them apart with a conversation directory per state directory. Removing
    the file moves the store's web sessions to the next state directory used.
  - Web-bound sessions keep in-process serve's model catalog check:
    `authorizeModel` now receives the session id, and the daemon asserts the model
    against the catalog for bound sessions only.
  - `local_leases` is now advertised, although `session.control.*` (Part 2) still
    answers `unavailable`. **Deviation** from `transport-unix.md` §5's "MUST NOT be
    advertised … until backed by the Host": the token covers serve and control
    leases together, so serve could not ship without it. Every client of this
    contract ships from this repository at the same version and treats
    `unavailable` as a clean refusal; Part 2 removes the gap.
- **Why:** Moves serve onto the daemon without widening web authority, and keeps
  the in-process path (`TERM2_IN_PROCESS=1`, or no `TERM2_DAEMON_MODE=1` until
  the Step 14f flip) behaviourally unchanged.

