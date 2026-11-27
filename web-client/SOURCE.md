# Source ledger

Salvaged from the ChatForge checkout at
`~/chat-term2-integration/chat` (absolute:
`/home/qduc/chat-term2-integration/chat`), branch `integration/v1-chat`,
commit `ae398a4`. Everything under `components/term2/`, `components/Term2Entry.tsx`,
`components/ChatHeader.tsx`, `contexts/`, `hooks/useTerm2Session.ts` (since deleted; its body is
`lib/term2/shell/open-session.ts`),
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
| `components/term2/Term2SessionShell.tsx#Term2SessionShell` | UI entry with `initialSessionId:string|null`, optional `authUserId:string|null`, optional packaged `homeFolder:string`, optional `allowWrite:boolean`, and the settings page's URL state `settingsSection`/`settingsProvider:string|null` (from `?settings=`/`?provider=`, read by `Term2Entry`). Layout only: it builds the `ShellEnv` and arranges the regions under `components/term2/shell/` (sidebar, settings page, chat column with header, welcome checklist, notices, turns, live status, pending interaction, diagnostics and the dock with the composer; tasks panel; provider, folder, help and rewind dialogs) in today's DOM order. `authUserId` is a UI reset signal, not gateway authorization. The packaged page supplies its home folder as a starting point for browsing and whether the launcher was started with `--allow-write`; folder validation, selection and access checks still go through the gateway. |
| `components/term2/shell/ShellContext.tsx#Term2ShellProvider` | Owns one `ShellRuntime` for the page's life and starts/stops it on mount; renders `ShellFeeds` (the only effects that dispatch: address bar, first mount, user change, first send, notice drain, status line) and `PageEffects` (tab title, notifications, visibility dataset, animation heartbeat, Cmd/Ctrl+K). The context value is the runtime and the env, never state. Components read with `useShellState`, `useSessionView`, `useChatFacts` (selector plus optional equality; pass `shallowEqual` from `lib/term2/store.ts` for an object) or `useStoreSelector` on a data store, and write with `shell.dispatch(action)` or `shell.ops.<name>()`. Leaves outside `shell/` (settings page, dialogs, usage chip) reach the data layer with `useServerData()`. Static rules (`scripts/gates/web-shell-rules.mjs`): no state setter or dispatch directly in an effect body here (ceiling for `ShellFeeds.tsx` in `scripts/rule-baseline.json`); no component or hook imports `lib/api/term2` (three recorded exceptions: the folder browser, the saved-folder menu, the diagnostics configure panel); only `shell-commands.ts` imports `lib/term2/chat-navigation.ts`. `@` suggestions use session-scoped listing for persisted chats and workspace-scoped listing for drafts; opening suggestions does not create a chat. |
| `lib/term2/shell/shell-runtime.ts#createShellRuntime` | No React. `ShellRuntime`: `store` (the machine's state) and `dispatch` (runs `step`, re-points `session` when the open chat changes before listeners are told, then runs each command through `shell-commands.ts`, the one command runner); `session` (`OpenSession`); `data` (`ServerData`); `prefs` (browser preferences and prompt history); `facts` (every derived value, `chat-facts.ts`, recomputed only when an input changes identity); `ops` (multi-step actions: send, retry, resend from a turn, rewind, apply or stage config, new chat, folder changes, images, skills, provider setup); `composer` (a handle the composer sets while mounted); `start`/`stop`. The chat list is re-read when the open chat enters or leaves a live status and when the sidebar opens, so its per-thread dot follows a turn and catches chats running in other tabs; a quiet page never polls. |
| `lib/term2/shell/open-session.ts#OpenSession` | No React. The open chat's `Term2SessionStore` (stream lifecycle, accepted checkpoint, reconnect), its view as a store (`NO_SESSION` when none), and the requests that act on it: `submit`, `invokeCommand`, `manageQueue`, `controlTask`, `rewind` (with `forResend`), `abort`, `resolveInteraction`, `refresh`, `frames`. Feedback (`submitError`, command notice, pending command) is keyed by session, so work still in flight for the previous chat never speaks for the one now open. Message submission is disabled until the chat is connected, running or interrupted (`canSubmitSessionMessage`). |
| `lib/term2/chat-navigation.ts#openChat` | No React. The writes that put the open chat into the address bar: `openChat`, `leaveChat`, `forgetChatSilently`. Only the shell's command runner imports it (rule `web-chat-navigation`), so every change of chat is a machine transition first. The settings parameters are written by `lib/term2/navigation.ts`. |
| `lib/term2/data/server-data.ts#createServerData` | No React. Settings projection, model catalog, skills, the `@` file listing (keyed by scope), saved folders, the chat list, the open chat's quota and rewind points (keyed by chat, re-read on each use) and the provider catalog, each a `Resource` (`lib/term2/data/resource.ts`): one state shape (`data`, `loading`, `refreshing`, `loaded`, `error`, `key`) and one late-response rule (only the request started last installs data or clears the flags; a request for another key empties the value; `set`/`update` install a local value without cancelling, `replace` installs a write's answer over every request in flight), checked by the generated property `web.resource-latest-wins`. Also folder details from this page load's folder picks, chat insert/title patch and the next chat page. `writeSettings` is one queue (`settings-writer.ts`): one write at a time against the revision held when its turn comes; either answer is installed with `replace`, so a read sent before it cannot put old values back; after a conflict the server's projection is installed and the write rejects (checked by `web.settings-writes-in-order`). `providers.*` (provider, credential and sign-in writes) re-read settings, then the model list, before resolving (`providersChanged`). A screen that asks each time it opens uses `hooks/useLoadOnOpen.ts`: loading until its own request answers. The open chat's config is not here: it stays in the machine under the tag rule. |
| `components/term2/settings/Term2SettingsPage.tsx#Term2SettingsPage` | Full-page settings that replaces the chat view while `?settings=<section>` is present (the chat stays mounted, hidden). The shell opens it with `pushState` (so Back returns to the chat), moves between sections and providers with `replaceState`, and `onClose` either goes back or drops the parameters. It reads and writes the page's one settings projection, `data.settings` (props have no `onLoaded`/`onModelsChanged`), staying on its loading line until this opening's read answers, then showing that read until the store installs something newer (installing it when the store is still empty, so writes have a revision); settings writes go through `data.writeSettings`, provider, credential and sign-in writes through `data.providers`, and presets through `data.providerCatalog`. Which projection keys appear, in which section, with what labels, units and search keywords is data in `settings/settings-catalog.ts`; keys it does not describe are not shown. Browser-only preferences (theme, tool display, notifications, diagnostics) arrive as props. API keys are write-only: the page never receives or shows a stored secret. |
| `lib/term2/shell-machine.ts#step` | Pure `step(state, action) → { state, commands }`, no React or I/O. State is user intent: the open chat (changed only by `URL_CHANGED`, from the address bar), a `generation` bumped on every change of what the page shows, the chosen folder, a draft and its first send, the open chat's config, staged model/effort, the composer (`input`, attachments, armed skill, history position, palette), notices (resend/config/attachment), the message on its way, the transcript pin, the delayed post-tool status, the background-notice drain boundary, the panels (running tasks, sidebar, dialog, skills picker; the sidebar is `null` until the page's first mount measures the screen, so the server render and first paint leave it to CSS: open on wide screens, closed on small ones), per-chat intent (`configApply`, `retryError`, `retryDraft`, cleared whenever `generation` moves) and the page's error banner (`pageError`, page-level). Types live in `shell-state.ts`, re-exported here. `CHAT_PICKED`, `NEW_DRAFT`, `DRAFT_DISCARDED` and `USER_CHANGED` move the address bar through the `navigate` command (`history: 'replace'` for a user change, which the runner reports back itself). Commands carry `{ sessionId, generation }` and result actions echo it; `step` drops a result whose tag is no longer current. Rules: a chat change empties the composer and notices except a draft's handoff to the chat it created; staged picks apply before a message that starts a turn; one message on its way at a time (Send in a chat takes the place of that chat's first message from the draft while it still waits); a refused Edit/Retry puts its text back with the resend notice; drain once per accepted boundary plus one re-ask after a busy or failed answer; a status after a tool row shows after `POST_TOOL_STATUS_DELAY_MS`; only the user opens or closes the running tasks panel and the sidebar; the rewind dialog and skills picker close when the chat on screen changes. Checked by the generated property `shell.machine-rules` (`scripts/generated-verification/shell.mjs`). |
| `lib/api/term2.ts#term2Client` | Browser HTTP facade, typed parsers and domain errors. Calls local BFF paths, not provider endpoints or the Unix socket directly. Workspace file listing (`listWorkspaceFiles`) is grant-scoped and can serve draft mentions without creating a session; session file listing remains session-scoped. Optional `AbortSignal` is propagated; facade requests disable generic automatic HTTP retries. Stream retry ownership belongs to the session store; original configure-command retry belongs to its caller. |
| `components/term2/Term2SessionConfig.tsx#Term2SessionConfig` | Receives optional session/config/settings plus `onDiscovered`, `onCreateNewSession`, and reauthentication state. Session-keyed UI owns the mounted original configure request/retry handle (model, reasoning effort, mode, and `approvalMode`). `onDiscovered` supplies current discovery only, not an original receipt. |
| `lib/term2/types.ts#Term2SessionView` | Read model consumed by shell/evidence UI: root turns/status (including chronological `items` for interleaved reasoning, text, and tool executions), nullable interaction, accepted checkpoint, separate hydration and native public state, actual branch views, accepted evidence and connection-local live observations. It is not provider history, a billing accumulator or a new persisted session format. |

Message submission is disabled until the selected session is connected, running or interrupted;
a hydration or stream error must remain visible rather than being replaced by a
late submission acknowledgement. Reload retries the session connection.
A failed message POST records a session-scoped `submitError` without flipping a
healthy SSE stream into `'error'`: the composer retains the draft text and stays
usable so the user can edit or retry immediately.
`submit(text, options?)` accepts optional `delivery` (`auto`/`steer`/`follow_up`/`reject_if_busy`),
`expectedSteerTurnId`, `skill`, and image `attachments`, and returns `Promise<boolean>`;
other mutation/control actions expose completion through their promise and view/feedback.
`createSession` retains its existing creation metadata result (`SessionProjection`);
that result is **not** a session cut. Only the first `snapshot` frame of the session stream installs one.

### Facade and BFF boundaries

The public facade groups are:

- Workspace/session discovery and creation: `listWorkspaces`, `listSessions`
  (including optional server-projected `title` and `model`), `createSession`;
  candidate validation/browse/selection remain separate capability-based workspace controls.
- Conversation: `openDirectEvents` (the `direct-wire-v2` stream), `submitMessage` (with optional
  delivery mode, skill, and bounded image attachments), `abort`,
  `resolveInteraction`, `commands` (compact/retry-tool/retry-turn),
  `listRewindTargets`, `rewindSession`, `manageQueue` (edit/retract/resume/discard),
  `controlTask` (cancel/check_in/foreground/background/drain_notifications),
  `listSessionFiles` (for `@` path mentions), and `readSessionQuota` (the subscription
  flag and the provider's last-reported plan windows; the wire carries no quota change, so
  the usage popover rereads it after each model response it sees and when opened; `data.quota` holds the value). The shell (through
  `shell-machine.ts`) sends `drain_notifications` when an idle chat (no running root turn, root approval,
  or queued or paused message) holds undelivered background notices, once per
  accepted boundary plus one delayed re-ask after a busy or failed answer: the Session
  never wakes the agent for a task that finishes while idle unless an attached client
  asks, as the TUI does. Actual session/turn/request identities
  are caller/server data, not browser-generated recovery cursors. New message/command
  intents use real caller-owned keys.
- Session configuration: `readSessionConfig` (current discovery) and
  `updateSessionConfig` (stable original `SessionConfigUpdate` returning shared
  `AgentConfigureResultV2`). Receipt-bearing non-2xx is meaningful result data;
  unknown delivery is not permission to issue a replacement intent/key.
- Settings/provider/skill/model/credential/OAuth controls: existing settings projections,
  revision conflicts, `listProviderPresets`, `writeProvider`, `deleteProvider`,
  `listSkills`, and dedicated mutation methods remain app-owned; M6's
  event schema does not silently version or redefine their DTOs.

`Term2ApiError` carries HTTP status/code/details; `SettingsConflictError` adds the
current settings revision/projection. `Term2ProtocolError` identifies native
hydration/stream contract failure and reload requirements. Abort is cancellation,
not evidence that a remote accepted mutation was undone. A stream protocol error
or replay gap cannot authorize a v1 fallback or invented successful receipt.

Browser paths under `app/api/agent/` and `app/api/term2/` are Node.js BFF handlers.
`lib/server/proxy.ts#rpc` maps them to the private gateway API; a browser GET may
become a purpose-bound POST control RPC (with per-route timeout override where
appropriate, such as OAuth login). Hydration, SSE and keyed configuration
explicitly opt into `format=agent-wire-v2`; the events route also passes
`format=direct-wire-v2` through unchanged (same cursor validation, upstream format
must match), which the browser does not request yet. The BFF validates local input,
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

The transcript has one source of truth (docs/plans/web-client/web-transcript-single-source.md):

- `lib/term2/generated/wire-fold.js` is the shared fold (`src/protocol/fold/`), bundled by
  `scripts/build-web-fold.mjs` and not committed. The browser owns no reducer: a new event type is handled in
  the fold for every client at once.
- `lib/term2/session-store.ts#Term2SessionStore` owns one session's `direct-wire-v2` connection, the accepted
  checkpoint, the current `WireSnapshot` and the answerable interaction DTOs. The first `snapshot` frame is the
  page load (there is no separate hydration request); accepted frames at or before the checkpoint are ignored;
  live frames never move it; an unreadable frame, an unavailable replay or HTTP 410 ends in Reload required.
  Publication is at most once per animation frame while visible. With diagnostics on, it keeps the last 200
  frames for `Term2NativeEvidence`; nothing reads state from them.
- `lib/term2/present.ts#present` is the only place a transcript rule is written (spec section 2.5): snapshot to
  `Term2SessionView`, reusing unchanged turns by identity. Components read the view, never the snapshot; the
  panels read `view.session` (tasks with their branch turns, queue, notifications, request receipts, session
  usage, goal, verification).
- `lib/term2/receipt-cost.ts#summarizeReceiptCosts(receipts)` is pure presentation of request receipts (latest
  record per real requestId; priced/unpriced counts and status); it mirrors `summarizeCost` arithmetic without
  importing it.

Results with no call stay in `unmatchedToolResults` and are not cards. Live-only observations (reasoning deltas,
tool progress) live in the snapshot's live fields and are replaced by the server's snapshot on reconnect.

Server/native owners produce accepted facts, snapshots, real identities and
provider-required history. Shared-wire owners produce versioned schemas/parsers;
packaging/integration owns both consumer pins/locks/vendor artifacts and gate
activation. Browser/BFF owns only consumption, local state and presentation.
No missing implementation owner is identified inside this slice. Provider
continuation verification and the combined M6 verifier must be allocated by the
coordinator; this browser handoff does not assign or impersonate those owners.

Other limits: no durable browser outbox or retry handle across navigation; no
browser-owned journal/history synthesis; historical receipt coverage is unknown and native aggregate
cost can be unavailable; absent branch capability differs from
an empty branch list; null branch queue/usage is not fabricated empty/zero.
The receipt-presentation work starts from candidate `65194f48`, which already
pins the shared 0.2.0 artifact; this change adds no wire vocabulary or package pin.
Its fast browser build and bounded pure author checks do not establish browser
journeys, replay/provider behavior or independent acceptance. Slow suites/full
review/provider workflows remain deferred. The combined gate stays closed;
this documentation claims no end-to-end acceptance.
