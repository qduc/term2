# Web client: gateway completion

## Resume here

**Status (2026-09-12): every implementation milestone is merged. term2 main: M0 `38d7cd7d`, M1 `8351e165`, M2 `73a9e3ab` (follow-up `6ddc5c0b`), M5b `0114bb6e`, M4 `5c8a3fb5`. ChatForge `integration/v1-chat`: M5c `2caf86c`, M4c `507b1cb`. Only the live E2E run is open.**

Three rules carried into later milestones, because they were learned the hard way:
- `createProductionRuntimeFactory` gives each session isolated settings and reads from
  the launcher only an exact allowlist whose entries must start with `agent.` or
  `webSearch.` (`runtime-factory.test.ts` enforces this). The first M1 draft passed every
  non-session key through from the host, so a host running `shell.autoApproveMode:
  always` would have auto-approved every browser-driven tool call.
- A turn the gateway starts on its own (a retry command, for example) must not write a
  synthetic `user_message` fact. `conversation-replay.ts` turns every `user_message`
  into provider history, so an empty one corrupts the model's context after a restart.
- Restart recovery of a *child* (subagent) interaction settles the child with
  `subagent_interrupted` and never appends `turn_failed` to the originating turn. That
  turn has usually already completed, and a second terminal event flips it to failed in
  both the gateway projection and ChatForge. Child approvals currently work only
  through the foreground-lease path; async subagents can only ask questions
  (contract 13 §7).
- A restored session comes back on the provider/model it was created with, never on the
  launcher's current default. Creation durably records a per-session snapshot sidecar in
  the session directory (a failed write rolls the whole `session_create` back with
  `503 snapshot_unwritable`); restore validates that snapshot against the live
  registry/catalog and refuses on substitution risks. Absent sidecar = pre-change legacy
  session, restored on the validated current launcher snapshot (identity may change);
  corrupt sidecar = `500 session_snapshot_invalid`, never treated as legacy. Full rule:
  contract 13 §9.
- Write posture is not inherited from the persisted identity snapshot: on fresh creation
  and restart revival it is recomputed from the current launcher `--allow-write` authority
  and the revalidated binding access. Only `read_write` plus `--allow-write` is writable;
  a `read` grant stays read-only across restart.

The web client is ChatForge at `~/chat-term2-integration/chat/` (a git repo on
branch `integration/v1-chat`). It has a frontend and a BFF backend that calls this
gateway. The gateway and BFF were built by an earlier program whose records live
in `~/chat-term2-integration/`: `PLAN.md`, `RESUME-HERE.md`,
`subplans/browser-owned-term2-control/MAP.md`, and
`subplans/research/w6-runtime-launcher.md`. **Read `MAP.md` before changing
any decision below.** It records decisions this plan inherits.

That program reached a *fixture-level* acceptance bar. The live demo answered
"Fixture local-owner response." because its launcher,
`subplans/scripts/term2-gateway-local.mjs`, lives outside this repo and uses a
fixture provider and a fake `createAgentClient`. This plan replaces the
fixture with the real runtime, moves the launcher into term2, and widens the
event and command surface so ChatForge can reach terminal-UI parity.

## Decisions

- **D1 — BFF only (settled 2026-09-12).** The browser never talks to the
  gateway. This inherits `MAP.md` ("Browser-to-gateway direct networking" is out
  of scope). The BFF (`backend/src/lib/term2GatewayClient.js`) pairs with the
  gateway using the OTP, signs assertions with the fingerprint kid it receives,
  and puts the ChatForge user id in `sub`. Because the BFF acts for many users,
  paired keys are deliberately **not** pinned to one subject. Local-owner
  purposes stay gated by `claims.sub === localOwnerUserId`
  (`LOCAL_OWNER_PURPOSES` in `gateway.ts`).
  *Rejected:* supporting direct browser pairing as well. That needs a role
  recorded at pairing time, because `/pairing/register` cannot tell a BFF key
  from a browser key, and it would reverse the MAP decision for no identified
  user need.
- **D2 — Deployment shape is inherited from `w6-runtime-launcher.md`.** A Unix
  socket with mode `0660` owned by the OS user, with credentials in the
  launcher process. The chain is: real `SettingsService` → provider registry →
  `AgentClient` → `ConversationService`. The fixture broker must not reach
  production. TLS network mode stays available as the non-default option the
  demo used.
- **D3 — Both repos are in scope (settled 2026-09-12).** Each new gateway event
  or command gets a matching ChatForge change (`frontend/lib/term2/event-adapter.ts`,
  BFF routes, UI). The ChatForge specs for these features are
  `subplans/08-session-controls.md` (commands) and `subplans/11-async-features.md`
  (subagents, background work). Both are marked deferred in
  `ACCEPTED-PLAN-INDEX.md`. Follow them where they are still accurate against
  the code.
- **D4 — Wire changes are additive only.** Add new event types and routes; never
  rename an existing field. The journal replays old events, and the client's
  `event-adapter.ts` switches on the existing type names.

## What exists (verified 2026-09-12)

- Gateway routes under `/private/agent/v1/`. The route table is the path
  matcher near the end of `gateway.ts` (grep `'/private/agent/v1/sessions'`).
  Each route maps to an `ASSERTION_PURPOSES` entry in `contracts.ts`.
- `RuntimeFactory` (`runtime-factory.ts`) throws `client_factory_missing`
  without `createAgentClient`. Nothing in this repo supplies a real one.
- `mapConversationEvent` in `gateway.ts` forwards 8 of about 35
  `ConversationEvent` types (`conversation-events.ts`) and turns every `error`
  into `reason: 'runtime_error'`. The client's `event-adapter.ts` handles 17
  gateway event types.
- The commands in `source/commands/` are reachable only from Ink.

## Milestones

| ID | Repo | Work | Waits on |
| --- | --- | --- | --- |
| M0 | both (read) | Wire inventory → `docs/contracts/13-gateway-web-wire.md` | — |
| M1 | term2 | Real `createAgentClient` and runtime wiring | — |
| M5a | term2 (read) | Sort each command: headless-safe, Ink-only, or needs extraction | — |
| M2 | term2 | `term2 serve` replaces the out-of-tree launcher | M1 |
| M4 | term2 | Widen the event projection | M0 |
| M5b | term2 | Command RPC route | M0, M5a |
| M4c | chat | Adapter and UI for the new events | M4 |
| M5c | chat | BFF route and UI for commands | M5b |
| E2E | both | Live stack: `term2 serve` + BFF + a real provider turn | M2, M4c, M5c |

### M0 — Wire inventory

List every gateway route, header, event type, and error code that the ChatForge
BFF (`backend/src/lib/term2GatewayClient.js`, `backend/src/routes/agentGateway.js`)
and frontend (`frontend/lib/term2/`) use. Diff that list against the gateway.
List the `ConversationEvent` types and commands the client has no way to
receive. Record the result in `docs/contracts/13-gateway-web-wire.md`. Exit:
the document is merged, and each gap is assigned to M4 or M5b, or explicitly
deferred with a reason.

### M1 — Real runtime

Implement the production `createAgentClient` described in
`w6-runtime-launcher.md` §"fixture-fake→real mapping". Build the real
`AgentClient` with the model, reasoning, and turn/retry settings the CLI uses,
and reuse the per-session owners in `session-client-factory.ts` and
`session-composition.ts`. Do not fork composition. Credentials stay in the
launcher process. Exit: a gateway integration test runs a scripted-provider
turn through the real `ConversationService` and gets `turn_completed`.
`pnpm test:provider-black-box` passes.

### M2 — `term2 serve`

Add a CLI subcommand that replaces `term2-gateway-local.mjs`. It covers the
state directory, manifest plus sha256, replay DB, trust file (`0600`), an
OTP-pairing toggle, `localOwnerUserId`, a Unix socket (`0660`) by default,
and TLS network mode behind an explicit flag. On SIGINT/SIGTERM it uses the
existing bounded shutdown. Exit: a `*.integration.*` test starts it as a child
process, pairs, runs a turn, and shuts down cleanly. ChatForge's BFF
configuration is documented for both socket and TLS modes.

### M4 / M4c — Event projection

Extend `mapConversationEvent` to cover the gaps from M0. Every payload goes
through `boundedText` or a sanitizer on the pattern of `interaction-protocol.ts`,
because events are persisted and replayed to a browser. Replace the single
`runtime_error` with a bounded set of reason codes. Subagent approvals must go
through the existing `PendingInteractionDto` path. Update the frozen allowlist
test deliberately. Exit for each new type: a mapper test, and a replay test
that reconnects from a cursor before the event. M4c adds the matching
`event-adapter.ts` cases and UI in ChatForge, with frontend tests.

### M5a / M5b / M5c — Commands

M5a classifies each command. M5b exposes the headless-safe ones through one
`POST /sessions/:id/commands` route with a `command_invoke` assertion purpose
and an allowlist of command ids. Rewind uses the conversation store's opaque
snapshot-scoped targets, never raw indices. M5c adds the BFF route and the UI.

## Out of scope

- Direct browser access to the gateway (D1).
- Multi-host or public deployment, and SSH workspaces (`sshEnabled` stays false).
- Changing Ink behavior.
