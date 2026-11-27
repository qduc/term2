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
