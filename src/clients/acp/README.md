# Direct ACP client boundary

This subtree supports stable ACP v1 and implements experimental ACP v2 against the published direct
protocol through `82d37ded91705090bc6b253301c7411ac5d5e389` (including
`77bca90b`/`5451b43c`) and native keyed-command Session `f14c9baa`. Imports target
`protocol/wire.ts` and `host/in-process-direct-types.ts`.
The app composes this implementation directly; see the public ACP reference for the supported SDK contract and remaining release acceptance limits.

## App integration and security

The app composes `DirectHost`, an authenticated `Principal`, a diagnostic logger,
and `AcpWorkspaces`, then calls `createAcpBackend`. Pass that backend and the app
version to `createAcpAgent` or `serveAcp`. `createStdioAcpIo` adapts Node stdio;
`serveAcp` selects the SDK 1.4.0 v1 or experimental-v2 agent from the first initialize request, using SDK-owned `ndJsonStream` framing. JSON-RPC framing,
transport IDs and schema validation remain SDK-owned. The existing v2 surface retains its method names and acknowledgement/idle contract.

## Stable v1 and JetBrains Air

The v1 surface targets mandatory v1 behavior and the capabilities advertised below.
Optional features are not implied by protocol version alone; see the audit matrix.
Valid unsupported version offers receive the latest supported version (2); an
exact offer of 1 or 2 retains its corresponding SDK contract.

`term2 acp` also accepts `initialize.protocolVersion: 1` without a CLI flag.
`v1/v1-agent.ts` advertises `agentInfo`, `authMethods: []`, image/embedded-context
prompts, session load/list/resume/close. Provider credentials remain native Term2
configuration. Setup responses include `model` and `thinking_level` select config options;
`session/set_config_option` applies a per-session native configure command and
waits for its exact completed receipt, including the accepted model identity.
A v1 prompt stays pending until its real
terminal and returns `stopReason`. Turn failures return a JSON-RPC error with
a client-facing message and structured `kind` and `retryable` fields. These
messages use Term2 wording so private provider response text stays local.
`session/load` creates a fresh display attachment and replays retained history;
resume attaches without replay. Repeated loads replay each time.

`client.ts` translates v1 permission `toolCall` requests while the shared
permission code preserves exact option IDs, scope, cancellation and provenance.
`v1/v1-output.ts` converts whole message upserts to append-only chunks, retaining
streamed prefixes so final messages/snapshots do not duplicate text. Tool upserts
become a first `tool_call` followed by `tool_call_update`, retaining the tool name.
Shell titles describe the actual command; raw input/output remain available as
structured metadata. Without a display extension, output is standard text tool
content, including when provider content is an empty array. `v1/v1-terminals.ts`
uses the declared Air/Zed agent-owned terminal convention: clients opting into
`_meta.terminal_output_delta:true` receive suffixes on that channel; otherwise
`_meta.terminal_output:true` selects Zed's chunk channel. Terminal references,
`terminal_info` and `terminal_exit` bracket output. Each fresh load replays it
once; repeated snapshots do not append it again. These are display extensions,
not client terminal execution. The native result includes its formatted exit
and runtime information; numeric terminal exit metadata remains null because
the bridge has no separate authoritative numeric exit field. Do not parse a
formatted result to invent one, or put tool output into assistant history.

V1 clients already display submitted input. After native admission, the attachment
marks that exact message ID before releasing its event gate; only that client's
own user-message echoes are suppressed, even in later snapshots. Suppression is
scoped to the v1 display attachment, so a fresh load replays every user message,
including distinct messages with identical text. V2 user-message delivery is unchanged.
V2-only state updates
stay off the v1 wire. The translator fails explicitly if previously displayed
content would need replacement; v1 has no replacement operation.

V1 structured questions and budgets use form elicitation only when the client
declares `clientCapabilities.elicitation.form`; otherwise they retain the
stop/decline fallback. Filesystem/terminal execution delegation and provider
management are not advertised. V1 selected permission IDs must match an offered
option exactly; operational errors use -32010, distinct from reserved
authentication-required -32000. Unknown sessions use -32002.


`models.ts` owns selector values (`provider/model`, split at the first slash),
catalog validation and short-lived Host subscriptions for configure receipts.
The app supplies enabled, credentialed streamed-provider catalogs. Setup reads
only cached entries and always includes the actual current model, even when its
provider is no longer ready. Provider discovery runs after setup and sends
`config_option_update`; it cannot hold up the connection. Refresh results for
replaced attachments are discarded; publication waits for pending selections
and reads the latest accepted model before updating the client. Changes affect
only the named session and survive native load/resume; global preferences stay
unchanged. Discovery failure preserves the current model and cached options.

Thinking level uses the standard `thought_level` category and offers Low,
Medium, High and Extra high. Provider support varies. When ACP v1 attaches a
session with a legacy effort, Default becomes Medium and None or Minimal
become Low. The native configure receipt confirms the selected level. Model
changes preserve the session's effort, and global effort preferences stay
unchanged.

Air's loading/sign-in timeout can mask initialization failure: the observed
WebStorm Air log offered `protocolOffer=V1` then reported `Invalid params` against
the former v2-only endpoint. Its later stdout `EPIPE` followed client shutdown;
it was not evidence of missing provider credentials. The former workaround of
disabling Air's forwarded MCP catalog is no longer required: app-owned
`app/acp/acp-sessions.ts` connects session-supplied stdio/HTTP/SSE servers through the
existing manager, immutable catalog and `run_code` approval machinery. Server
credentials remain process memory, are not copied into settings or display
metadata, and are not provider credentials. Each session owns its connections;
opening or reopening a session proceeds with reachable servers when others
fail to connect. Failed replacement preserves the accepted catalog. Retired managers remain
alive for older native generations until explicit close drains the session.
EOF drains application work before closing those resources.

`AcpWorkspaces.authorize` resolves canonical cwd to an admitted workspace grant.
`cwd(sessionId)` supplies canonical **direct** session workspace metadata under
the same principal as Host. Resume checks cwd, but the connection snapshot has no
workspace field. Neither callback may construct an adopted runtime or read old
logs. List metadata comes only from Host, including its optional native title and
updatedAt; neither value is fabricated when absent.

ACP v1 adds one **Approval mode** selector alongside model and thinking level.
**Ask** is the default. Ordinary shell commands run sandboxed; a missing or
failed sandbox stops the command. **Assisted** keeps confinement and uses
Term2's approval evaluator for eligible foreground approvals, including
sandboxed shell mutations flagged by the command safety classifier. Only a
high-confidence, authorized, low-risk result auto-approves; other results
fall back to the client's permission request. **Always · Sandbox off** runs
shell commands outside the sandbox and skips routine approval prompts.
Questions and explicitly scoped capabilities, including forwarded MCP calls,
retain their own approval policy.

Changes use native idle configuration admission and install the tool policy and
sandbox setting together. Mode changes also require background work to settle.
A live session retains the selection across attachment changes and model or
effort updates. Closing or reopening the runtime resets it to Ask. Global
preferences and persisted configuration omit the approval selection.

In Ask or Assisted, the model can retry a blocked command with `sandbox: "unsandboxed"`. Only a
foreground shell in the main ACP v1 agent can request **Run outside sandbox once**.
The request includes the exact command and working directory. The distinct
`unsandboxed-once` grant applies to that invocation and directory. A plain Allow
once has no escape authority. Rejection, cancellation, and a directory change
prevent the retry. The resulting process uses the Term2 user's OS permissions.
ACP v2 continues to require confinement for every shell execution.

App keeps diagnostics off stdout, supplies process shutdown signals and disposes
Host after serving returns.

## Admission, content and interactions

- Prompts send one UUID-keyed `submit`, with `origin:acp` and explicit
  **`delivery:reject_if_busy`**. The published protocol calls native
  `Session.submitWithDelivery`; no app capability injection is required. ACP has
  no auto-delivery fallback, submit-then-retract workflow or speculative retry.
  A queued/steering receipt violates this mode and raises an integration error.
- The local ACP slot rejects simultaneous prompts before sending; shared Session
  owns cross-client admission. Acknowledgements and the output ordering gate do
  not acknowledge engine work or prove completion. Started work waits for its
  exact real terminal. Real input message/turn identities correlate admission;
  no client sequence replaces durable seq.
- Text and resource links are baseline input. Embedded text resources are advertised
  through prompt.embeddedContext and read from resource.text (there is no nested
  resource.type discriminator). Images
  use image/\* MIME and raw padded RFC4648 base64, never a fetched path/URL or data
  URI. Representation is checked before admission without adding a size cap or
  provider permission policy. Image-only prompts and text after images retain
  block order. V1 embedded image blobs become image attachments with URI context;
  other embedded blobs retain their URI/MIME/base64 as opaque text context, without
  fetching the URI. This does not add PDF/audio interpretation to a model. Audio
  blocks and v2 binary embedded resources remain unsupported.
- Each permission, question or budget request owns a separate cancellable client
  exchange; it never blocks the event pump. Answers target exact request IDs.
  Root and task-owned native answers retain that provenance in their accepted
  resolution facts and Host events. Known client actions send `provenance:{source:'user'}`; unsupported methods,
  malformed responses and local error fallbacks send `source:'system'`. Missing
  provenance is never treated as evidence of a human decision.
- Approvals retain approve/reject option IDs and the allow-once alias. Recognized
  scoped/Docker options are offered only from actual `supportedGrants`, sent as
  exact grant decisions, never collapsed to allow or cached. Unknown selections,
  cancellation and unsupported permission methods deny. Session owns real scope
  validation; no absent grant capability is invented.
- Questions use ACP `elicitation/create` form mode only when the initialized
  client explicitly advertises a non-null elicitation.form capability. Budget
  forms use the same gate; unsupported clients receive native system fallbacks
  without an outbound elicitation request. Known stable-ID question
  sets preserve single/multiple choices, descriptions where supported, and custom
  text. The entire answer set is sent once; Session owns canonical serialization.
  Explicit decline differs from cancel/invalid/unsupported responses, which send
  decline plus stopAfterApprovalResolution rather than fabricated approval denial.
- Real `budget_opened` and snapshot pendingBudgets use a **separate** form showing
  public accepted evidence/snapshot, with extend or stop choices. Only explicit
  extend requests `{kind:'extend',grantedBy:'human'}` with user provenance. Decline
  or cancel stops; malformed/unsupported exchanges stop with system provenance.
  ACP grants no budget itself, applies no threshold, offers no parent/steer bypass
  and never turns auto-approval into a human grant. Session owns actual extension,
  closure and terminal behavior. Resolved/ended/detached requests cannot answer a
  different owner.

## Keyed Session commands and additive wire data

ACP currently sends only `submit`, `answer`, `answer_budget` and turn-targeted
`cancel`. Session new/list/resume use Host methods; close detaches after observing
known foreground cancellation. ACP has no retry/compact/configure/rewind/rollover,
command-status or command-receipt endpoint. Prompt text (including slash text) is
not converted into one of those operations. No new command key or private ACP
extension is needed for the existing surface.

Protocol `82d37ded` requires stable per-invocation `commandId` on those keyed
operations and exposes typed pending/finished/refusal/interrupted replies,
snapshot.commands and command_started/command_finished events. None of ACP's
four outgoing command shapes changed. Those receipt events and snapshot fields
are not ACP prompt outcomes and are intentionally not translated into success,
idle, an execution retry or a synthetic transcript item. In particular, even a
finished retry receipt is not the retried turn's terminal. ACP still settles only
its observed real turn terminal; it does not execute/status-query someone else's
receipt, fabricate a command-kind key or retry an outcome_unobserved operation.
The typed receipt API remains protocol-owned, not exposed as a lossy ACP facade.

Ancestor `77bca90b` adds accepted physical request-cost records; ACP does not
synthesize an aggregate price or legacy cost stream from them. `5451b43c` adds
legacyCommandMessages for actual source-formatted tool-finish display DTOs,
which are distinct from keyed Session receipts. ACP retains public display in
tool rawOutput and text/image tool content; it does not call that legacy helper
or infer command IDs, status, blank success or legacy command-event parity.

## Display, terminals and replay

Live and fresh-snapshot messages consume actual `replacesDraftId`, turn/model-step
metadata and accepted mixed `snapshot.timeline`. Stream-to-final replacement stays
on the real draft display identity; no tagged/legacy ID formula is guessed.
Append-compatible finals send only a suffix; full-message upserts preserve
corrections and images. Reasoning consumes actual full/delta message IDs and
snapshot reasoningIdentity; only genuinely identity-less deltas use a coarse
per-turn thought ID, without inventing a model step.

Tools use execution IDs, not repeatable provider call IDs. Text/image content and
public JSON display survive live/nested/snapshot output; opaque provider frames
never reach ACP. Progress accumulates because ACP content updates replace rather
than append. Finished tools use actual accepted name/input when supplied, and
otherwise remain unnamed output updates. Tool result messages do not duplicate
execution display. Fresh attachment and snapshot refresh also consume accepted `snapshot.branches`
through renderers keyed by real branch identity. They preserve each branch
transcript order without inventing a total root/branch chronology. Branch
renderers are isolated by supplied branch/agent identity;
a child snapshot or terminal cannot replace root renderer/foreground state.

Unmatched tool results are retained by execution ID, without a made-up name. The
native accepted reducer and public fold now add a `kind:tool` timeline slot at
the first actual call/start **or result** for that execution. Repeated finish/item
result evidence keeps that original slot; it does not append output after later
messages. Native snapshot synchronization preserves this accepted order. ACP's
existing replay resolves an unnamed slot from `unmatchedToolResults`, sending an
output update without inventing a start, name, input, timestamp or call ID.
Fresh attachment still needs the real accepted prefix to recover result content;
a timeline entry alone cannot supply missing output. Null/incomplete timelines
continue to fail explicitly rather than guess chronology. No new accepted fact,
wire event, sequence, journal or ACP extension is involved.

Snapshots use real activeTurnId, drafts, terminal and historical turnResults.
Observed terminal outcomes, not submit/cancel receipts or queue disappearance,
settle foreground work. Only actual terminalCause:budget_exhausted selects the
budget-exhausted stop reason. Explicit cancel/close waits for any in-flight submission admission, captures
that prompt ownership, and sends expectedTurnId for the observed turn and discardQueue:false; native admission performs the comparison.
A no-op/abort receipt is not proof physical cleanup finished. Close observes a
known terminal, then the Host drains and releases the native Session (including
background work) and app-owned MCP connections. Retained history can be reopened.
EOF/shutdown detaches subscriptions/requests; application disposal owns native
Session/background drain. There is no client shutdown timeout.

ACP replayFrom:start means **fresh atomic snapshot plus subsequent live events**.
Previously hidden history remains hidden on resume without replay; snapshot
upserts retain observed display order and aliases. Null/malformed timeline data
is never interpreted as all messages preceding all tools.

Host numeric cursor attachment is distinct: snapshot:null, retained-state tail,
then authoritative cut-state snapshot and live events. It must not reset to
current state before the historical tail. SDK ACP v2 has no agreed numeric cursor
variant/retained-state contract here. ACP accepts standard replayFrom:start,
rejects unknown variants and does not invent a cursor extension or client seq.

## Remaining seams and verification limits

- A numeric ACP cursor extension requires an agreed retained-state/watermark
  contract if that transport feature is required. Host tail and fresh replay are
  not interchangeable.
- Budget/history/response/branch wire data is not legacy private provider history
  or an aggregate settled price. Events without an ACP display equivalent remain
  telemetry, not invented transcript entries or control capabilities.
- Process cases in `tests/clients/acp/spec.integration.test.ts` and
  `tests/clients/acp-v2/serve.integration.test.ts` cover SDK stdio, image/embedded
  input, rejected extensions, replay, real shell permissions, EOF and signals.
  Native filesystem-backed SDK suites in `tests/clients/acp/` cover question
  sets, budgets, provenance and lifecycle races; no permanent unit suite is added.
- A packed npm installation outside the checkout passed the process cases and a
  live Gemini 3.8 Flash turn through the SDK 1.4.0 experimental/v2 reference
  client on Node 24.19.0/Linux (2026-11-08). No GUI editor was validated.
- The default agent command sandbox lacks `socat` and prevents nested namespace
  setup. Those runs verify approved shell calls fail closed. A second run on
  the managed host, outside that command sandbox with a locally extracted
  official Debian socat 1.8.0.3, requires successful workspace writes for both
  `approve` and `allow-once` and verifies outside-workspace writes remain blocked.
  Use `TERM2_ACP_REQUIRE_SHELL_SUCCESS=1` on a sandbox-capable host to make the
  success path mandatory rather than accepting sandbox refusal.

## Draft comparison and current activity

The online v2 draft evolves independently of SDK 1.4.0. Preserve this pinned
SDK's empty prompt acknowledgement, exact-v2 initialization and tool_call
announcement shapes until a coordinated SDK/client migration. These differ
from the current online draft and are not claims of full draft compliance.

Every attachment sends a current state snapshot even without history replay.
Native interaction events do not require a separate status_changed event: the
shared protocol reducer supplies foreground state, including concurrent
interactions and background task distinctions. The adapter reports
requires_action while blocked and running when progress resumes. Historical
stop reasons are not re-announced as new completions during attachment.
Failed turns report idle with `stopReason: "error"` and a JSON-RPC error object.
The pinned experimental SDK preserves the same details under `_meta.term2.error`
when decoding the update.

Build with `pnpm build`, then run
`pnpm test:integration tests/clients/acp tests/clients/acp-v2/serve.integration.test.ts`.
The live packed reference-client turn used Node environment proxy support
(`NODE_USE_ENV_PROXY=1`) for the configured Google endpoint.

## V1 audit matrix

Audited against the [stable v1 specification](https://agentclientprotocol.com/protocol/v1/initialization),
the pinned SDK 1.4.0 schema, and the upstream
[Air/Zed display conventions](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md).
GUI acceptance remains separate from these protocol and native-runtime checks.

| Contract | Implementation and integration evidence |
| --- | --- |
| UTF-8 NDJSON, clean stdout, initialization/version negotiation | SDK framing and `serveAcp`; built CLI `negotiation.integration.test.ts`, `spec.integration.test.ts` |
| Text and resource links; advertised image/embedded context | `promptInput`, `v1Prompt`; built CLI content/embedded-resource cases |
| Mandatory stdio MCP; advertised HTTP/SSE | App `createAcpSessions`; actual MCP processes/loopback transports, explicit env/cwd/headers, approval, failed replacement and sibling isolation |
| Pending prompt, cancel, exact terminal and late permission answers | `createAcpV1Agent`, native interaction/lifecycle suites |
| One-time outside-sandbox shell requests | Built CLI sandboxed success, sandbox denial, explicit grant, generic allow rejection and repeated requests |
| Exact permission choices and negotiated forms | `v1Client`; native accept/deny/unoffered alias, question accept/decline/cancel/invalid cases |
| Full load replay, resume without history, own-message suppression | `V1Output`; repeated live/load/resume and identity cases |
| Tool title/input/result and opt-in terminal output | Shared renderer and `V1Terminals`; live and loaded command output on both channels and standard-content fallback |
| Session close cancels/drains/frees resources; retained log reopen | Host `closeSession`, app resource ownership; built CLI close/load/MCP invocation and independent disposal-failure probe |
| Model and thought-level configuration, session-local persistence | Native configure receipts; built CLI catalog/model/effort/default/load/resume cases |
| Optional features not implemented | Audio blocks, extra workspace roots, session modes/fork/delete, slash commands, plans, provider management and delegated client FS/terminal execution are not advertised |

The WebStorm Air plugin declares `terminal_output_delta`; the standalone Air app
is a different consumer. Inspecting the standalone app's renderer does not
establish what the WebStorm plugin displays.
