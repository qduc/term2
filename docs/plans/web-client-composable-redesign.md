# Web client: composable redesign

## Status

Design proposal (2026-09-29), not yet implemented. The gateway surface this design
builds on is complete and merged — see [web-client-gateway-completion.md](web-client-gateway-completion.md)
for that program's status and open follow-ups.

## Goal

Make term2's browser access a composable architecture instead of a fused vertical:
term2 exposes stable seams (wire contract, trust, event stream), and clients become
interchangeable. The first client is salvaged from the ChatForge checkout rather
than written fresh.

Decisions settled with the user (2026-09-29):

1. **Client:** salvage the ChatForge term2 frontend slice (not a from-scratch client).
2. **Exposure:** configurable LAN binding — but the gateway itself stays off the LAN
   (see topology below); the salvaged thin server is the LAN-facing tier.
3. **Scope:** full peer — the web client can do everything the TUI can, including
   approvals and subagent steering.

## Architecture

```
L4  Clients — replaceable, all peers of the TUI:
      Ink TUI · web client (salvaged slice) · scripting · future clients
L3  Session façade — services/conversation (exists)
L2  Gateway — HTTP+SSE projection of L3, /private/agent/v1/ (exists, 21 routes)
L1  Trust seam — pairing + scoped assertions (exists: --pairing, OTP,
      x-term2-assertion verification, LOCAL_OWNER_PURPOSES)
```

The load-bearing discovery: term2 already owns the trust seam. `term2 serve --pairing`
issues a five-minute OTP; a client registers a keypair via
`POST /private/agent/v1/pairing/register` and then signs short-lived assertions.
ChatForge's BFF was never the trust owner — it was merely the first client to use
this seam. Any client with a keypair can pair directly.

### Deployment topology

```
browser (LAN, TLS, thin-server auth)
   → salvaged thin server (Next.js API routes; pairs with gateway over Unix socket)
      → term2 serve (Unix socket only, never network-bound)
```

The gateway's own TLS/`--allow-remote` mode exists and is gate-tested
(`serve-args.ts` refuses non-loopback `--listen` hosts without `--allow-remote`),
but this design does not use it: binding the gateway to the LAN would widen the
trust boundary to any LAN host holding an assertion. The thin server is the only
network-exposed tier, so remote access runs entirely through code this repo owns.

## Evidence base (verified against source, 2026-09-29)

Four parallel explorations; claims below were verified in source, and several
correct the completion plan's recorded facts.

### Gateway surface (L2)

- Route table: `matchPrivateRoute()` in `source/gateway/gateway.ts` defines 21 routes —
  workspaces, workspace candidates, models, settings, credentials, OAuth, session
  create/list/read/config, messages, abort, commands, interactions, SSE events.
  Every input/steering verb a peer needs exists, including
  `POST .../interactions/{interactionId}` for approval answering.
- Auth: one assertion check at the server boundary (`server.ts`), then
  purpose-match per route in `#handleRpc()`. `LOCAL_OWNER_PURPOSES` restricts the
  seven admin purposes (settings/credential/oauth) to the local owner's subject.
- SSE is served from the durable session journal/projection, not a live tap, with
  cursor replay (`?after=`) and reload-required on compacted replay. Multi-client
  attachment is therefore architecturally free.
- Session restore uses a `session-snapshot.json` sidecar recording provider/model/
  effort; corrupt = `session_snapshot_invalid`, absent = legacy behavior.

**Correction:** the completion plan's "8 of ~35 events forwarded" is an M0-era
snapshot and no longer true. `mapConversationEvent()` currently forwards 21 event
types (tool started, approval required with interaction bindings, full subagent
lifecycle, retry/failure, compaction, usage). ~17 types fall through to `null`.

### Approvals and subagents over the wire

- Root approvals are wire-complete: `approval_required` publishes an interaction
  binding and DTO; the client resolves via the interactions route with revision
  checks (stale = 409; multi-question `ask_user` bumps revision and returns
  `accepted: false`; cancellation passes `stopAfterApprovalResolution: true`).
  Covered by `gateway.test.ts` interaction cases.
- Adopted foreground child approvals resolve through the session-owned FIFO
  controller (`backgroundSubagentApprovals`) via `background_approval` bindings.
- Async child questions publish `subagent_question` and answer through
  `answerBackgroundSubagentQuestion()` into the async registry mailbox.
- **Gap (runtime-level, not wire-level):** native async child approvals never
  publish a pause — only foreground-adopted children are resolvable. Contract 13
  records this explicitly. This is the largest full-peer deficiency.
- Multi-client semantics: interaction bindings are session-scoped and published in
  the shared journal; resolution validates interaction ID/revision, not client
  identity. First valid revision wins; no client-ownership lease exists. Both
  attached clients see every interaction. Adequate for a personal-use peer model;
  revisit if adversarial multi-user is ever in scope.
- TUI vs wire: the TUI's only extra capability is local Ink input ownership
  (Escape/cancel rendering). A wire client uses the interaction route instead.
  No gateway/TUI capability gap was found beyond the async-child-approval gap.

### ChatForge salvage boundary

ChatForge checkout: `~/chat-term2-integration/chat`, branch `integration/v1-chat`,
HEAD `ae398a4`, clean except untracked `backend/data/`.

The term2 web UI is already a self-contained client slice, separate from
ChatForge's product code (which activates only without `?term2=1`):

- **Import:** `frontend/components/term2/*` (session shell, list, workspace picker,
  folder selector, session config, command menu/card, interaction panel, subagent
  card, status banner, settings panel), `frontend/components/Term2Entry.tsx`,
  `frontend/hooks/useTerm2Session.ts`, `frontend/lib/api/term2.ts`,
  `frontend/lib/term2/{types,event-adapter,sse}.ts`.
- **Import:** `backend/src/lib/term2GatewayClient.js` — self-contained (~520 lines),
  zero ChatForge product dependencies: pairing, RS256 assertion creation with
  purpose/binding validation, socket/TLS transport, bounded responses, gateway
  error normalization. SSE forwarding in the route layer is byte pass-through
  (`upstream.pipe(res)`) with an idle timeout — the BFF adds no event logic.
- **Adapt:** the route validators and request shapes from
  `backend/src/routes/agentGateway.js`, plus four small in-memory stores the
  frontend's conventions rely on: public-cursor HMAC map, session/workspace
  bindings, dynamic workspace grants, per-session config cache.
- **Replace:** ChatForge auth (`AuthContext`, `components/auth/`, `lib/api/auth.ts`)
  with a minimal single local-owner identity. The frontend never signs assertions;
  it expects a server that injects them (`sub` sourced server-side), which is
  exactly what the thin server does.
- **Discard:** `ChatV2.tsx` and the legacy chat surface, and all product APIs
  (`conversations`, `chat` completions/judge, `providers`, `tools`, `files`,
  `images`). None is load-bearing for the term2 slice.
- The frontend already models the wire vocabulary locally
  (`AgentEventEnvelope`, `SessionProjection`, `PendingInteraction` in
  `lib/term2/types.ts`) with a versioned envelope and dedicated event adapter,
  and works around one wire wart client-side (`user_message_accepted` omits
  `text`; the client enriches from its `clientRequestId` pending map).

### Contract drift

`docs/contracts/13-gateway-web-wire.md` is pinned to term2 commit `fbec9bb6` and
self-describes as an inventory. Known staleness: its 36-vs-8 event table is an M0
snapshot; the frontend's `POST /agent/sessions/:id/commands` route is absent from
its route table. Milestone A below re-inventories it. Until then, cite gateway
source, not the contract, for wire facts.

## Milestones

Ordered; each is independently verifiable.

- **A. Contract refresh.** Re-inventory routes/events/errors against current
  source; fix the stale event table and add the commands route. Gate: contract
  matches `matchPrivateRoute()` and `mapConversationEvent()` output.
- **B. Event projection table.** Replace the hardcoded switch in
  `mapConversationEvent()` with a declared event-type → wire-payload table so
  contract completeness is a testable property. Tiering decision recorded here:
  add `subagent_question_answered`, `tool_recovery`, `background_shell_started`,
  `background_shell_completed`, `background_shell_output`; keep dropped:
  streaming micro-deltas (`tool_call_streaming_delta`, `subagent_streaming_*`),
  budget/cost internals (`run_budget_event`, `cost_update`, `codex_rate_limit`),
  and `memory_injected`. Net effect: clients can render background-shell activity
  and question answers; wire stays free of high-frequency progress noise.
- **C. Salvaged web client.** Import the slice and gateway client; build the thin
  Next.js server (pairing via socket, ported validators, four stores, single
  local-owner auth); serve over TLS on LAN; gateway on Unix socket only. Gate:
  live pairing + session create + message + approval resolve through the browser.
- **D. Deployment/threat-model doc.** LAN posture, token/pairing lifecycle,
  revocation (trust-file deletion + restart), what `--allow-write` grants. A
  deployment setting, not new mechanism.
- **E. Full-peer closure.** Async child approvals publishing pauses (runtime
  work, spans services + gateway); verify no remaining TUI-only capability.
- **Rides along (not blocking):** codex manual compaction failures on multi-turn
  sessions (inherited from the completion plan's open follow-ups); unmerged
  `wg-e2e` live harness — merging it early strengthens milestone C's gate.

## Rejected alternatives

- **Browser-direct to gateway.** Rejected in the completion program (D1) because
  pairing had no browser-viable home. This design keeps the thin server rather
  than reopening it: putting assertion keys in the browser widens the trust
  boundary for marginal process-count savings.
- **Importing ChatForge's backend.** Its auth, rollout, grant, and telemetry
  layers exist for ChatForge-the-product, not for gateway access. Keeping them
  would preserve the fused vertical this design removes.
- **Gateway LAN binding.** Mechanism exists but is unused here; the socket-only
  gateway plus LAN-facing thin server achieves remote access with a smaller
  trust surface.

## Open questions

- Does the thin server keep the BFF's opaque public cursors, or expose gateway
  cursors directly to the browser? Keeping them is cheap (one HMAC store);
  dropping them simplifies the client. Decide during milestone C.
- Client identity in interaction resolution: none exists today. Fine for
  personal use; record as a deliberate non-goal for now.
