# Source ledger

Salvaged from the ChatForge checkout at
`~/chat-term2-integration/chat` (absolute:
`/home/qduc/chat-term2-integration/chat`), branch `integration/v1-chat`,
commit `ae398a4`. Everything under `components/term2/`, `components/Term2Entry.tsx`,
`components/ChatHeader.tsx`, `contexts/`, `hooks/useTerm2Session.ts`,
`lib/api/term2.ts`, `lib/term2/`, `lib/http.ts`, `lib/storage.ts`,
`lib/streaming.ts` originates there.

## Server-side ports (from ChatForge backend)

- `lib/server/term2-gateway-client.js` — verbatim port of
  `backend/src/lib/term2GatewayClient.js` (@ `ae398a4`). Deliberate deviations:
  - Config sourcing: ChatForge's `config.term2Gateway` singleton replaced by
    `lib/server/gateway-config.js` reading `TERM2_*` env vars. Issuer default is
    `chatforge-bff` because that is the gateway's `DEFAULT_SERVE_ISSUER`.
  - `logger.warn` transport-failure logging dropped (no logger in this client).
  - `createAgentAssertion` no longer defaults issuer/audience/keyId from ChatForge
    config; they are always passed by `issueAssertion`.
  - Exported singleton unchanged (`term2GatewayClient`).

## Behavioral deviations from ChatForge's BFF (backend/src/routes/agentGateway.js)

Prototype scope (create-session, SSE, message send, approval) only:

- Gateway event-stream and JSON responses pass through byte/shape-identical; the
  BFF's opaque cursor HMAC rewriting is dropped — gateway cursors reach the
  browser as-is.
- The BFF's workspace-grant projection, rollout admission, telemetry, and
  multi-user auth are not ported. Identity is the single
  `TERM2_LOCAL_OWNER_USER_ID` (default `local-owner`).
- Session→workspace bindings are kept as an in-memory map
  (`lib/server/session-bindings.js`), refilled from `session_list` on miss —
  functionally equivalent to the BFF's `sessionWorkspaceStore` +
  `workspaceForSession` minus its projection dependence.
- Route validators are simplified from the BFF's (`hasOnlyKeys` checks kept for
  session create/message/interaction; length limits loosened to 1MB).
- Routes not exercised by the prototype flow are not implemented (settings,
  credentials, OAuth, commands, abort, session config, term2 local-control).

## Frontend slice deviations

- `contexts/AuthContext.tsx` — replaced with a fixed local-owner stub
  (`useAuth()` shape preserved, no login flow).
- `components/ChatHeader.tsx` — model selector, tabbed-select type, and auth
  button pruned; props kept for call-site compatibility.
- `components/term2/flags.ts` — `isTerm2UiEnabled()` defaults on (env can
  disable with `NEXT_PUBLIC_TERM2_UI_ENABLED=false`).
- `components/Term2Entry.tsx` — the legacy `ChatV2` default branch is removed;
  the app always renders the term2 session shell.
- `app/layout.tsx`, `app/page.tsx`, `package.json` — new (Next 16 app shell,
  deps pruned to slice usage).

## Versioned wire consumer migration

The original provenance above describes the salvaged baseline, not today's full
feature surface. The local M6 browser/BFF source targets explicit agent-wire-v2;
see [WIRE.md](WIRE.md) for the v1/v2 ledger, exact shared-source dependency,
configuration receipt/discovery distinction, migration and activation limits.
This is not evidence that the independently maintained ChatForge consumer has
migrated, or that the unbuilt 0.2.0 shared source is already installed here.

## Browser module public interface and ownership

This section is the maintained public-interface map for the **browser/BFF
module**, beyond the version-specific [wire contract](WIRE.md). M6 entries are
source targets, not activated or verified support. Maintain this section when
changing exported UI/hook/facade contracts, HTTP entry points, trust/ownership
boundaries, compatibility or recovery limits; keep WIRE.md aligned when their
wire semantics change. Shared rule provenance is agent-runtime ORIGINAL
`67d3cba8151d83eee851a9eb5638e27e6f193f64` (parent option-B docs
`c01d054a253bb2451c2cb8bc9e4bcc6ea37375d6`); this browser module applies the
same user requirement without changing another owner's instructions.
Tiny internal helpers do not need separate boilerplate
documents. TypeScript exports establish the exact signatures; the map explains
who may use them and what they own.

### Entry points and caller responsibilities

| Surface | Public contract / ownership |
| --- | --- |
| `components/term2/Term2SessionShell.tsx#Term2SessionShell` | UI entry with `initialSessionId:string|null`, optional `authUserId:string|null`, and `onExit:()=>void`. Owns selection, drafts, sidebar and session/settings presentation. Identity/selection transitions clear the previous draft. `authUserId` is a UI reset signal, not gateway authorization. |
| `hooks/useTerm2Session.ts#useTerm2Session` | Takes the selected `sessionId:string|null`; returns `UseTerm2SessionResult`. Owns the active hydrate/stream lifecycle, accepted checkpoint, reconnect state, pending message text and interaction/command feedback. Callers use returned actions rather than opening a second stream or mutating the view. Session generation/abort checks prevent stale work installing another selection's state. |
| `lib/api/term2.ts#term2Client` | Browser HTTP facade, typed parsers and domain errors. Calls local BFF paths, not provider endpoints or the Unix socket directly. Optional `AbortSignal` is propagated; facade requests disable generic automatic HTTP retries. Stream retry ownership belongs to the hook; original configure-command retry belongs to its caller. |
| `components/term2/Term2SessionConfig.tsx#Term2SessionConfig` | Receives optional session/config/settings plus `onDiscovered`, `onCreateNewSession`, and reauthentication state. Session-keyed UI owns the mounted original configure request/retry handle. `onDiscovered` supplies current discovery only, not an original receipt. |
| `lib/term2/types.ts#Term2SessionView` | Read model consumed by shell/evidence UI: root turns/status, nullable interaction, accepted checkpoint, separate hydration and native public state, actual branch views, accepted evidence and connection-local live observations. It is not provider history, a billing accumulator or a new persisted session format. |

`UseTerm2SessionResult` exposes workspace/session arrays and pagination cursors,
workspace selection, `refreshWorkspaces`, `refreshSessions`, `loadNextSessions`,
`createSession`, `selectSession`, `submit`, `invokeCommand`, `abort`,
`resolveInteraction`, and explicit `refresh`, plus view/command feedback.
`submit(text)` returns `Promise<boolean>`; other mutation/control actions expose
completion through their promise and view/feedback. `createSession` retains its
existing creation metadata result (`SessionProjection`); that result is **not**
the new native hydration cut. Only `hydrateSession` supplies the negotiated cut.

### Facade and BFF boundaries

The public facade groups are:

- Workspace/session discovery and creation: `listWorkspaces`, `listSessions`,
  `createSession`; candidate validation/browse/selection remain separate
  capability-based workspace controls.
- Conversation: `hydrateSession`, `openEvents`, `submitMessage`, `abort`,
  `resolveInteraction` and `commands` (compact/retry-tool/retry-turn). Actual
  session/turn/request identities are caller/server data, not browser-generated
  recovery cursors. New message/command intents use real caller-owned keys.
- Session configuration: `readSessionConfig` (current discovery) and
  `updateSessionConfig` (stable original `SessionConfigUpdate` returning shared
  `AgentConfigureResultV2`). Receipt-bearing non-2xx is meaningful result data;
  unknown delivery is not permission to issue a replacement intent/key.
- Settings/model/credential/OAuth controls: existing settings projections,
  revision conflicts and dedicated mutation methods remain app-owned; M6's
  event schema does not silently version or redefine their DTOs.

`Term2ApiError` carries HTTP status/code/details; `SettingsConflictError` adds the
current settings revision/projection. `Term2ProtocolError` identifies native
hydration/stream contract failure and reload requirements. Abort is cancellation,
not evidence that a remote accepted mutation was undone. A stream protocol error
or replay gap cannot authorize a v1 fallback or invented successful receipt.

Browser paths under `app/api/agent/` and `app/api/term2/` are Node.js BFF handlers.
`lib/server/proxy.ts#rpc` maps them to the private gateway API; a browser GET may
become a purpose-bound POST control RPC. Hydration, SSE and keyed configuration
explicitly opt into `format=agent-wire-v2`. The BFF validates local input,
resolves session/workspace binding, uses the configured local owner identity and
purpose-bound gateway assertions, and forwards native bodies/receipt evidence
and negotiated headers. It must not synthesize aggregate state, re-key commands,
rewrite accepted cursors/times, join interactions at another cut or copy a root
queue into a branch. Mutation request guards remain owned by
`lib/server/request-guards.ts#assertLocalStateChangingRequest`; this is a local
single-user boundary, not a port of ChatForge multi-user authorization.

`lib/server/gateway-config.js` owns server-only environment configuration,
assertion key material and socket transport configuration;
`lib/server/term2-gateway-client.js` owns gateway transport/assertions and native
error handling. Keys/secrets do not belong in client-side state. The default
Unix-socket deployment and unused network reference path are documented in that
configuration module and the composable web-client plan. This source migration
does not establish deployment/security acceptance for a new topology.

### Internal ownership and compatibility limits

`lib/term2/hydration.ts` owns browser validation of the separately negotiated
native snapshot and native-owned transcript/timeline references.
`event-adapter.ts#applyTerm2Event` owns atomic accepted installation and actual
branch routing; `native-state.ts` owns browser validation/reduction of observed
public messages/tasks/cost/goals/verification/notices, **not** pricing or native
goal/task-running policy. Ordered native message entries retain real IDs and
replace only named drafts in place; root task descriptors retain nested
result.toolUseCounts and numeric task time as evidence. Current descriptor state
supersedes legacy cards with the same actual task identity. Accepted tool_called
creates a pending command by actual executionId; the original public descriptor
retains native callId/parent/input. A later physical start uses that same
execution key. Results lacking an observed call/start remain unmatched evidence,
not invented tool metadata. Pending tool UI explicitly means not started.
`event-adapter.ts#presentTerm2SessionView` is a presentation-only overlay for real
live turn_failed; underlying accepted state/checkpoints are unchanged. Shared
source `a4bcebc48dc22086c655a601bf4911c64882a8eb` separates accepted
admission from its general change union; `applyTerm2Event` narrows by kind and
uses the corresponding accepted/live types without casting. Live error
alone is not a terminal, and error is not in the accepted allowlist. Both
transient observations are connection-local and
removed on disconnect/hydration; later accepted lifecycle supersedes a live
failure. No provider-native history is built from these public records.
`sse.ts#consumeSseResponse` owns SSE framing and shared-envelope validation.
`Term2NativeEvidence` presents exact observations/limitations without equating
native verification with user-task success or request receipts with extra bills.
These are cohesive internal seams of this module, not separately versioned
public packages. Wire versions, same-cut semantics and exact external originals
are recorded in WIRE.md.

Server/native owners produce accepted facts, snapshots, real identities and
provider-required history. Shared-wire owners produce versioned schemas/parsers;
packaging/integration owns both consumer pins/locks/vendor artifacts and gate
activation. Browser/BFF owns only consumption, local state and presentation.
No missing implementation owner is identified inside this slice. Provider
continuation verification and the combined M6 verifier must be allocated by the
coordinator; this browser handoff does not assign or impersonate those owners.

Option B explicitly makes raw reasoning chunks and intermediate tool progress
live-only, including after reconnect/crash. The UI drops connection-local
observations on disconnection/hydration; accepted summaries and final tool
results are recovery evidence, not raw-stream replay parity. Complete
provider-required reasoning items/signatures/encrypted metadata and tool
calls/results remain provider/runtime responsibilities and must not be stripped.
Actual provider continuation is pending post-M6 verification. Live runtime
failure presentation is not a durable failed turn: the actual null-seq lifecycle
may settle visible activity, while hydration/current accepted state owns recovery.
No status_changed, missing terminal or missed transient history is fabricated.

Other limits: no durable browser outbox or retry handle across navigation; no
browser-owned journal/history synthesis; native fresh-process aggregate
cost/notice coverage can be incomplete; absent branch capability differs from
an empty branch list; null branch queue/usage is not fabricated empty/zero.
The old artifact remains pinned to 0.1.0, so new source imports are not installed
support. No #65 tests, probes, typechecks, guards, lint, builds, reviews, pack or
runtime/provider acceptance have run during the implementation freeze. The
combined gate stays closed; this documentation claims no end-to-end acceptance.
